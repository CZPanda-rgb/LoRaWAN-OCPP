#include <lmic.h>
#include <hal/hal.h>
#include <SPI.h>
#include <Preferences.h>
#include <vector>

#define CFG_eu868
#define voltageGrid             230
#define USE_OTAA
#define LORAWAN_SF              DR_SF7          // Spreading factor (recommended DR_SF7 for areas with good reception)
#define LORAWAN_ADR             0               // Enable ADR

static const u1_t PROGMEM APPEUI[8] = { fillmein};  // JoinEUI MSB MeteoScientific
static const u1_t PROGMEM DEVEUI[8] = { fillmein};  // DevEUI MSB MeteoScientific
static const u1_t PROGMEM APPKEY[16] = { fillmein};  // AppKey MSB TTN MeteoScientific

int heartbeatInterval = 30;
int meterValueSampleInterval = 30;  // in seconds, these two values will be updated by values received over LoRaWAN
int current = 10;                   // Amperes
// Message counter, stored in RTC memory, survives deep sleep.
static RTC_DATA_ATTR uint32_t count = 0;
unsigned long lastTxmillis = 0, sendRequested;
char TxQueue[20] = {0};
int EVSEstate = 1;  //1 Available; 2 Preparing; 3 Charging
int TxPointer = 0;
long Wh = 0, a = 0, lastJunkRegistered = 0, unusualA[20] = {0}, lastOP_TXRXPEND;
int allowCleanJunk = 0, junkRegistered = 0, counterUnusualA = 0, lastSendUART = 0, initiateImmediateSend = 0, transactionState = 0, pendingSend = 0;
int pendingSendAlreadyRegistered = 0;

std::vector<void(*)(uint8_t message)> _lmic_callbacks;

void os_getArtEui(u1_t* buf) {
  memcpy_P(buf, APPEUI, 8);
}
void os_getDevEui(u1_t* buf) {
  memcpy_P(buf, DEVEUI, 8);
}
void os_getDevKey(u1_t* buf) {
  memcpy_P(buf, APPKEY, 16);
}
void _ttn_callback(uint8_t message) {
    for (uint8_t i=0; i<_lmic_callbacks.size(); i++) {
        (_lmic_callbacks[i])(message);
    }
}
static void printHex2(unsigned v) {
    v &= 0xff;
    if (v < 16)
        Serial.print('0');
    Serial.print(v, HEX);
}
// If the value for LORA packet counts is unknown, restore from flash
static void initCount() {
  if(count == 0) {
    Preferences p;
    if(p.begin("lora", true)) {
        count = p.getUInt("count", 0);
        p.end();
    }
  }
}
static void set_frame_cnt() {
    LMIC_setSeqnoUp(count);
    // We occasionally mirror our count to flash, to ensure that if we lose power we will at least start with a count that is almost correct 
    // (otherwise the TNN network will discard packets until count once again reaches the value they've seen).  We limit these writes to a max rate
    // of one write every 5 minutes.  Which should let the FLASH last for 300 years (given the ESP32 NVS algoritm)
    static uint32_t lastWriteMsec = UINT32_MAX; // Ensure we write at least once
    uint32_t now = millis();
    if(now < lastWriteMsec || (now - lastWriteMsec) > 5 * 60 * 1000L) { // write if we roll over (50 days) or 5 mins
        lastWriteMsec = now;

        Preferences p;
        if(p.begin("lora", false)) {
            p.putUInt("count", count);
            p.end();
        }
    }
}
void ttn_sf(unsigned char sf) {
    LMIC_setDrTxpow(sf, 14);
}

// Piny pro TTGO LoRa32 (SX1276)
const lmic_pinmap lmic_pins = {
  .nss = 18,
  .rxtx = LMIC_UNUSED_PIN,
  .rst = 14,
  .dio = { 26, 33, 32 }
};

// ===== Přidáme osjob pro periodický uplink =====
static osjob_t sendjob;
const unsigned TX_INTERVAL = 60;  // sekundy mezi vysíláním

// Funkce, která odešle paket
void do_send(osjob_t* j) {
  // Pokud právě probíhá vysílání, odlož
  if (LMIC.opmode & OP_TXRXPEND) {
    if(millis() - 500 > lastOP_TXRXPEND){ //so that it doesnt print many massages to Serial when TXRX is not possible at the moment
      Serial.println(F("OP_TXRXPEND, skipped"));
      lastOP_TXRXPEND = millis();
    }
  } else {
    // Jednoduchý payload (1 byte s číslem 42)
    uint8_t payload[1];
    payload[0] = 42;

    // Port 1, nepožadujeme potvrzení
    LMIC_setTxData2(1, payload, sizeof(payload), 0);
    Serial.println(F("Packet naplanovan k odeslani"));
  }
  // Naplánuj další vysílání
  os_setTimedCallback(&sendjob, os_getTime() + sec2osticks(TX_INTERVAL), do_send);
}

void onEvent(ev_t ev) {
  Serial.print(os_getTime());
  Serial.print(": ");
  switch (ev) {
    case EV_JOINING:
      Serial.println(F("EV_JOINING (probiha pripojeni)"));
      break;
    case EV_JOINED: {
      // Disable link check validation (automatically enabled
        // during join, but because slow data rates change max TX
        // size, we don't use it in this example.
        if(!LORAWAN_ADR){
            LMIC_setLinkCheckMode(0); // Link check problematic if not using ADR. Must be set after join
        }

        Serial.println(F("EV_JOINED"));

        u4_t netid = 0;
        devaddr_t devaddr = 0;
        u1_t nwkKey[16];
        u1_t artKey[16];
        LMIC_getSessionKeys(&netid, &devaddr, nwkKey, artKey);
        Serial.print("netid: ");
        Serial.println(netid, DEC);
        Serial.print("devaddr: ");
        Serial.println(devaddr, HEX);
        Serial.print("AppSKey: ");
        for (size_t i=0; i<sizeof(artKey); ++i) {
            if (i != 0)
                Serial.print("-");
            printHex2(artKey[i]);
        }
        Serial.println("");
        Serial.print("NwkSKey: ");
        for (size_t i=0; i<sizeof(nwkKey); ++i) {
            if (i != 0)
                    Serial.print("-");
            printHex2(nwkKey[i]);
        }
        Serial.println();

        Preferences p;
        if(p.begin("lora", false)) {
            p.putUInt("netId", netid);
            p.putUInt("devAddr", devaddr);
            p.putBytes("nwkKey", nwkKey, sizeof(nwkKey));
            p.putBytes("artKey", artKey, sizeof(artKey));
            p.end();
        }
    }
      break;
    case EV_TXSTART:
      Serial.print(F("EV_TXSTART - vysilám na "));
      Serial.print(LMIC.freq);
      Serial.println(F(" Hz"));
      break;
    case EV_REJOIN_FAILED:
      Serial.println(F("EV_REJOIN_FAILED - nepodarilo se obnovit spojeni"));
      // tady můžeš třeba zkusit spustit LMIC_startJoining() znovu
      LMIC_reset();
      LMIC_startJoining();
      break;
    case EV_TXCOMPLETE:
      Serial.println(F("EV_TXCOMPLETE (odeslano)"));
      if (LMIC.txrxFlags & TXRX_ACK) {
        Serial.println(F("Server potvrdil zpravu (ACK)"));
      }

      if (LMIC.dataLen) {
        Serial.print(F("Prijat downlink: "));
        for (int i = 0; i < LMIC.dataLen; i++) {
          Serial.print(LMIC.frame[LMIC.dataBeg + i], HEX);
          Serial.print(" ");
        }
        int pointerRxRead = 0;
        while (pointerRxRead < LMIC.dataLen) {                  //TODO vyčítat všechny typy prichozich zprav
          if (LMIC.frame[LMIC.dataBeg + pointerRxRead] == 4) {  //RemoteStartTransaction
            transactionState = 1;
            TxQueue[TxPointer] = 4; //answer to remote start transaction
            TxPointer++;  //MSB gets send first
            TxQueue[TxPointer] = (Wh >> 24) & 0xFF; //send initial energy meter value
            TxPointer++;  //MSB gets send first
            TxQueue[TxPointer] = (Wh >> 16) & 0xFF;
            TxPointer++;
            TxQueue[TxPointer] = (Wh >> 8) & 0xFF;
            TxPointer++;
            TxQueue[TxPointer] = (Wh & 0xff);
            TxPointer++;  //LSB
            TxQueue[TxPointer] = 14; //connector status
            TxPointer++;  //LSB
            TxQueue[TxPointer] = EVSEstate;
            TxPointer++;  //LSB
            pointerRxRead++;
          } else if (LMIC.frame[LMIC.dataBeg + pointerRxRead] == 5) {  //RemoteStopTransaction
            transactionState = 0;
            pointerRxRead;
          } else if (LMIC.frame[LMIC.dataBeg + pointerRxRead] == 6) {  //SetMeterValueSampleInterval
            meterValueSampleInterval = 5 * (LMIC.frame[LMIC.dataBeg + pointerRxRead + 1]);
            pointerRxRead += 2;
          } else if (LMIC.frame[LMIC.dataBeg + pointerRxRead] == 7) {  //SetHeartbeatInterval
            heartbeatInterval = 5 * (LMIC.frame[LMIC.dataBeg + pointerRxRead + 1]);
            pointerRxRead += 2;
          } else if (LMIC.frame[LMIC.dataBeg + pointerRxRead] == 8) {  //GetMeterValueSampleInterval
              int tempMeterValueSampleInterval = ((meterValueSampleInterval / 5) < 255 ) ? (meterValueSampleInterval / 5) : 255;
              TxQueue[TxPointer] = tempMeterValueSampleInterval / 5;
              TxPointer++; 
              pointerRxRead += 1;
              initiateImmediateSend = 1;
          } else if (LMIC.frame[LMIC.dataBeg + pointerRxRead] == 9) {  //SetCurrentLimit
              current = LMIC.frame[LMIC.dataBeg + pointerRxRead + 1];
              pointerRxRead += 2;
          } else if (LMIC.frame[LMIC.dataBeg + pointerRxRead] == 10) {  //SetPowerLimit
            current = (voltageGrid/230)*(LMIC.frame[LMIC.dataBeg + pointerRxRead + 1]);
            pointerRxRead += 2;
          } else if (LMIC.frame[LMIC.dataBeg + pointerRxRead] == 11) {  //GetMeterValueSampleInterval
              int tempCurrent = current < 255  ? current : 255;
              TxQueue[TxPointer] = tempCurrent;
              TxPointer++; 
              pointerRxRead += 1;
              initiateImmediateSend = 1;
          }
          Serial.println();
        }
      }
      break;
    case EV_TXCANCELED:
      Serial.println(F("EV_TXCANCELED (TX zrušeno)"));
      break;

    default:
      Serial.print(F("Neznama udalost: "));
      Serial.println((unsigned)ev);
      break;
  }
}

void setup() {
  Serial.begin(115200);
  delay(1000);
  Serial.println(F("LoRaWAN OTAA - TTGO LoRa32"));
  Serial.print("DevEUI: ");
  for (int i = 0; i < 8; i++) {
    Serial.print(DEVEUI[i], HEX);
    Serial.print(" ");
  }
  Serial.println();

  Serial.print("AppEUI: ");
  for (int i = 0; i < 8; i++) {
    Serial.print(APPEUI[i], HEX);
    Serial.print(" ");
  }
  Serial.println();

  Serial.print("AppKey: ");
  for (int i = 0; i < 16; i++) {
    Serial.print(APPKEY[i], HEX);
    Serial.print(" ");
  }
  Serial.println();

  initCount();
  os_init();

// Nastav EU868 region
#ifdef CFG_eu868
  Serial.println(F("Region: EU868"));
#endif
  // Reset the MAC state. Session and pending data transfers will be discarded.
    LMIC_reset();
    Serial.println("reset LMIC");

    #ifdef CLOCK_ERROR
        LMIC_setClockError(MAX_CLOCK_ERROR * CLOCK_ERROR / 100);
    #endif

    #if defined(CFG_eu868)

        // Set up the channels used by the Things Network, which corresponds
        // to the defaults of most gateways. Without this, only three base
        // channels from the LoRaWAN specification are used, which certainly
        // works, so it is good for debugging, but can overload those
        // frequencies, so be sure to configure the full frequency range of
        // your network here (unless your network autoconfigures them).
        // Setting up channels should happen after LMIC_setSession, as that
        // configures the minimal channel set.
        LMIC_setupChannel(0, 868100000, DR_RANGE_MAP(DR_SF12, DR_SF7),  BAND_CENTI);      // g-band
        LMIC_setupChannel(1, 868300000, DR_RANGE_MAP(DR_SF12, DR_SF7B), BAND_CENTI);      // g-band
        LMIC_setupChannel(2, 868500000, DR_RANGE_MAP(DR_SF12, DR_SF7),  BAND_CENTI);      // g-band
        LMIC_setupChannel(3, 867100000, DR_RANGE_MAP(DR_SF12, DR_SF7),  BAND_CENTI);      // g-band
        LMIC_setupChannel(4, 867300000, DR_RANGE_MAP(DR_SF12, DR_SF7),  BAND_CENTI);      // g-band
        LMIC_setupChannel(5, 867500000, DR_RANGE_MAP(DR_SF12, DR_SF7),  BAND_CENTI);      // g-band
        LMIC_setupChannel(6, 867700000, DR_RANGE_MAP(DR_SF12, DR_SF7),  BAND_CENTI);      // g-band
        LMIC_setupChannel(7, 867900000, DR_RANGE_MAP(DR_SF12, DR_SF7),  BAND_CENTI);      // g-band
        LMIC_setupChannel(8, 868800000, DR_RANGE_MAP(DR_FSK,  DR_FSK),  BAND_MILLI);      // g2-band

    #elif defined(CFG_us915)

        // NA-US channels 0-71 are configured automatically
        // but only one group of 8 should (a subband) should be active
        // TTN recommends the second sub band, 1 in a zero based count.
        // https://github.com/TheThingsNetwork/gateway-conf/blob/master/US-global_conf.json
        // in the US, with TTN, it saves join time if we start on subband 1
        // (channels 8-15). This will get overridden after the join by
        // parameters from the network. If working with other networks or in
        // other regions, this will need to be changed.
        LMIC_selectSubBand(1);

    #elif defined(CFG_au915)

        // set sub band for AU915
        // https://github.com/TheThingsNetwork/gateway-conf/blob/master/AU-global_conf.json
        LMIC_selectSubBand(1);

    #endif

        // TTN defines an additional channel at 869.525Mhz using SF9 for class B
        // devices' ping slots. LMIC does not have an easy way to define set this
        // frequency and support for class B is spotty and untested, so this
        // frequency is not configured here.

        // Disable link check validation
        LMIC_setLinkCheckMode(0);

        #ifdef SINGLE_CHANNEL_GATEWAY
            forceTxSingleChannelDr();
        #else
            // Set default rate and transmit power for uplink (note: txpow seems to be ignored by the library)
            ttn_sf(LORAWAN_SF);
        #endif

    #if defined(USE_ABP)

        // Set static session parameters. Instead of dynamically establishing a session
        // by joining the network, precomputed session parameters are be provided.
        uint8_t appskey[sizeof(APPSKEY)];
        uint8_t nwkskey[sizeof(NWKSKEY)];
        memcpy_P(appskey, APPSKEY, sizeof(APPSKEY));
        memcpy_P(nwkskey, NWKSKEY, sizeof(NWKSKEY));
        LMIC_setSession(0x1, DEVADDR, nwkskey, appskey);

        // TTN uses SF9 for its RX2 window.
        LMIC.dn2Dr = DR_SF9;

        // Trigger a false joined
        _ttn_callback(EV_JOINED);

    #elif defined(USE_OTAA)

        // Make LMiC initialize the default channels, choose a channel, and
        // schedule the OTAA join
        LMIC_startJoining();

        #ifdef SINGLE_CHANNEL_GATEWAY
            // LMiC will already have decided to send on one of the 3 default
            // channels; ensure it uses the one we want
            LMIC.txChnl = SINGLE_CHANNEL_GATEWAY;
        #endif

        Preferences p;
        p.begin("lora", true); // we intentionally ignore failure here
        uint32_t netId = p.getUInt("netId", UINT32_MAX);
        uint32_t devAddr = p.getUInt("devAddr", UINT32_MAX);
        uint8_t nwkKey[16], artKey[16];
        bool keysgood = p.getBytes("nwkKey", nwkKey, sizeof(nwkKey)) == sizeof(nwkKey) && 
                        p.getBytes("artKey", artKey, sizeof(artKey)) == sizeof(artKey);
        p.end(); // close our prefs
        //keysgood = false; //when you need to get new keys by OTAA from LNS
        if(!keysgood) {
            // We have not yet joined a network, start a full join attempt
            // Make LMiC initialize the default channels, choose a channel, and
            // schedule the OTAA join
            Serial.println("No session saved, joining from scratch");
            LMIC_reset();
            Serial.println("reset LMIC");
            LMIC_startJoining();
        }
        else {
            Serial.println("Rejoining saved session");
            LMIC_reset();
            LMIC_setSession(netId, devAddr, nwkKey, artKey);
            LMIC.opmode &= ~OP_JOINING;

            // Trigger a false joined
            _ttn_callback(EV_JOINED);
            Serial.println("EV_JOINDED flag sent to the os");
        }

    #endif
}

void loop() {
  os_runloop_once();
  if (EVSEstate <= 2) {  //send Heartbeats only when EVSE is in state Available or Preparing, in Charging state EVSE sends MeterValuesSamples
    if ((millis() - lastTxmillis) > (heartbeatInterval * 1000)) {
      TxQueue[TxPointer] = 0x01;
      TxPointer++;
      pendingSend = 1;
      lastTxmillis = millis();
    }
  } /*else if (EVSEstate == 3) {
    if ((millis() - lastTxmillis) > meterValueSampleInterval) {
      TxQueue[TxPointer] = 13;
      TxPointer++;  //13 MeterValues (Energy.Active.Import.Register)
      TxQueue[TxPointer] = (Wh >> 24);
      TxPointer++;  //MSB gets send first
      TxQueue[TxPointer] = (Wh >> 16);
      TxPointer++;
      TxQueue[TxPointer] = (Wh >> 8);
      TxPointer++;
      TxQueue[TxPointer] = (Wh & 0xff);
      TxPointer++;  //LSB
      lastTxmillis = millis();
    }
  }
  if (Serial.available() >= 5) {
    a = Serial.read() << 24;
    a |= Serial.read() << 16;
    a |= Serial.read() << 8;
    a |= Serial.read();
    EVSEstate = Serial.read();
    junkRegistered = 0;
    digitalWrite(25, Wh & 0x01);
    if ((Wh + 60) > a) {
      if (a > Wh) {
        Wh = a;
        Serial.write(Wh >> 24);
        Serial.write(Wh >> 16);
        Serial.write(Wh >> 8);
        Serial.write(Wh);
      }
    } else {
      unusualA[counterUnusualA] = a;
      counterUnusualA++;
      long nejvetsi = LONG_MIN, nejmensi = 2147483647;
      for (int i = 0; i <= 19; i++) {
        nejvetsi = max(nejvetsi, unusualA[i]);
        nejmensi = min(nejmensi, unusualA[i]);
        if ((i & 7) == 0) delay(0); // each 8 iterations of free CPU
      }
      if (((nejmensi + 300) > nejvetsi) && (counterUnusualA == 20)) {
        Wh = a;
        Serial.write(Wh >> 24);
        Serial.write(Wh >> 16);
        Serial.write(Wh >> 8);
        Serial.write(Wh);
      }
      if (counterUnusualA >= 20) {
        counterUnusualA = 0;
      }
    }
  }*/
  if (Serial.available() == 0) {
    junkRegistered = 0;
  }
  if ((Serial.available() > 0) && (Serial.available() < 5)) {
    if (junkRegistered == 0) {
      lastJunkRegistered = millis();
      junkRegistered = 1;
    }
    if ((millis() - lastJunkRegistered) > 3000) {
      while (Serial.available()) {
        char dummy = Serial.read();
        Serial.println("cistim bordel");
        delay(0);
      }
      lastJunkRegistered = millis();
    }
  }
  if (millis() - 1000 > lastSendUART) {
    Serial.print("<ID:");
    int currentRestricted = transactionState ? current : 0;
    Serial.print(currentRestricted);
    Serial.print(">");
    lastSendUART = millis();
  }
  if((pendingSend == 1)&&(pendingSendAlreadyRegistered == 0)){
    pendingSendAlreadyRegistered = 1;
    sendRequested = millis();
  }
  if (((millis() - sendRequested) > 5000) && (pendingSendAlreadyRegistered == 1)){
    // Pokud právě probíhá vysílání, odlož
  if (LMIC.opmode & OP_TXRXPEND) {
    Serial.println(F("OP_TXRXPEND, preskoceno"));
  } else {

    // Port 1, nepožadujeme potvrzení
    set_frame_cnt(); // we are about to send using the current packet count
    LMIC_setTxData2(1, (uint8_t*)TxQueue, TxPointer, 0);
    Serial.println(F("Packet naplanovan k odeslani"));
    count++;
    pendingSend = 0;
    pendingSendAlreadyRegistered = 0;
    TxPointer = 0;
  }
  }
}