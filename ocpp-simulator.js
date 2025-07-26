const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');
const readline = require('readline');
const express = require('express');
const app = express();
const cors = require('cors');
const port = 3200;

const chargePointId = 'pureWSEVSE';
const ocppUrl = `ws://ocpp.eronx.cz:8080/steve/websocket/CentralSystemService/${chargePointId}`; // Změň podle potřeby
//const chargePointId = 'fd4821';
//const ocppUrl = `ws://ocpp.chargehq.net/ocpp16/${chargePointId}`; // Změň podle potřeby

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

let ws = new WebSocket(ocppUrl, 'ocpp1.6');
let messageId = 1;
let connectorStatus = 'Available';
let transactionId = null;
let energy = 0;
let meterInterval = 30;
let hearthbeatInterval = 10; // default fallback (sekundy)
let maxCurrent = 10;

const send = (action, payload) => {
  const msgId = uuidv4();
  const frame = [2, msgId, action, payload];
  ws.send(JSON.stringify(frame));
  return msgId;
};
function startHeartbeatLoop() {
  setInterval(() => {
    send('Heartbeat', {});
    console.log(`[OCPP] Posílám Hearthbeat, interval interval: ${hearthbeatInterval}s`);
  }, hearthbeatInterval * 1000);
}
function getUtcMidnightToday() {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

const changeStatus = (newStatus) => {
  connectorStatus = newStatus;
  send('StatusNotification', {
    connectorId: 1,
    status: newStatus,
    errorCode: 'NoError',
    timestamp: new Date().toISOString()
  });
};

const startMetering = () => {
  if (meterInterval) clearInterval(meterInterval);
  if (meterInterval < 1) {
    meterInterval = 1; // interval less than 1 second is too small
  }
  meterInterval = setInterval(() => {
    energy += 100; // každých X sekund přidej 0.1 kWh (simulace)
    send('MeterValues', {
      connectorId: 1,
      transactionId: transactionId,
      meterValue: [{
        timestamp: new Date().toISOString(),
        sampledValue: [{
          value: energy.toFixed(3),
          unit: 'Wh',
          measurand: 'Energy.Active.Import.Register',
        }]
      }]
    });
  }, meterInterval * 1000);
};

const stopMetering = () => {
  clearInterval(meterInterval);
  meterInterval = null;
};

ws.on('open', () => {
  console.log('[OCPP] Připojeno k backendu, posílám BootNotification...');

// Po připojení a úspěšném BootNotification
send('BootNotification', {
  chargePointModel: 'ACME Model X',
  chargePointVendor: 'ACME Inc.'
}, () => {
  // server odpověděl
  heartbeatInterval = responsePayload.interval || 60;

});


});

ws.on('message', (data) => {
  const msg = JSON.parse(data);
  if (msg[0] === 3) {
    const [_, id, payload] = msg;
    console.log(`[OCPP] Response (${id}):`, payload);

    // Pokud odpověď na BootNotification obsahuje interval
    if (payload.interval) {
      hearthbeatInterval= payload.interval;
      console.log(`[OCPP] Nastavený hearthbeat interval: ${hearthbeatInterval}s`);
      startHeartbeatLoop();
    }
    if (payload.transactionId){
      transactionId = payload.transactionId;
      console.log(`[OCPP] Prijali jsme odpoved na StartTransaction a TransactionId je : ${transactionId}`);
    }  
  } else if (msg[0] === 2) {
    const [_, callId, action, payload] = msg;
    console.log(`[OCPP] Příchozí požadavek: ${action}, obsah: ${JSON.stringify(payload)}`);

      if (action === 'StartTransaction') {
        ws.send(JSON.stringify([3, callId, {
          transactionId: transactionId,
          idTagInfo: { status: 'Accepted' }
        }]));
      } else if (action === 'StopTransaction') {
        transactionId = null;
        ws.send(JSON.stringify([3, callId, {
          idTagInfo: { status: 'Accepted' }
        }]));
    } 
    else if (action === 'ChangeConfiguration') {
      if (payload.key === 'MeterValueSampleInterval') {
      const value = parseInt(payload.value, 10);
      if (!isNaN(value) && value > 0) {
      meterInterval = value;
      console.log(`zmenen interval MeterValueSampleInterval na ${meterInterval}s`);
      ws.send(JSON.stringify([3, callId, {
        status: 'Accepted' }
      ]));
      } else {
      console.error('Neplatná hodnota MeterValueSampleInterval:', payload.value);
      ws.send(JSON.stringify([3, callId, {
        status: 'Rejected' }
      ]));
    }
  }
}

    else if (action === 'GetConfiguration') {
      const requestedKeys = payload.key || [];

      const response = {
        configurationKey: [],
        unknownKey: []
      };

      for (const key of requestedKeys) {
        if (key === 'MeterValueSampleInterval') {
          response.configurationKey.push({
            key: 'MeterValueSampleInterval',
            readonly: false,
            value: meterInterval
          });
        } else {
          response.unknownKey.push(key);
        }
      }
      const responseMessage = [3, callId, response];
      ws.send(JSON.stringify(responseMessage, null, 2));
      console.log(`Odpověď na GetConfiguration:`, JSON.stringify(responseMessage, null, 2));
      }
      else if (action === 'GetCompositeSchedule') {
        const requestedKeys = payload.key || [];
        let isoStart = getUtcMidnightToday();
        const response = {
          status: "Accepted",
          scheduleStart: isoStart,
          chargingSchedule: {
            duration: 86400,
            startSchedule: isoStart,
            chargingRateUnit: "A",
            chargingSchedulePeriod: [
            {
              startPeriod: 0,
              limit: maxCurrent
            }
          ]
        }
      }
      const responseMessage = [3, callId, response];
      ws.send(JSON.stringify(responseMessage, null, 2));
      console.log(`Odpověď na GetConfiguration:`, JSON.stringify(responseMessage, null, 2));
    }
    else if (action === 'SetChargingProfile'){
      try{
        if (payload.csChargingProfiles.chargingSchedule.chargingRateUnit === 'A' ){
          maxCurrent = payload.csChargingProfiles.chargingSchedule.chargingSchedulePeriod[0].limit;

        }
        const responseMessage = [3, callId, {status: "Accepted"}];
        ws.send(JSON.stringify(responseMessage, null, 2));
        console.log(`Odpověď na GetConfiguration:`, JSON.stringify(responseMessage, null, 2));
      }
      catch{
        console.log(`Nepodařilo se vyčíst max proud z požadavku SetChargingProfile`);
      }
    }
  }
});

rl.on('line', () => {
  if (connectorStatus === 'Available') {
    console.log('[SIM] Přechod na Preparing...');
    changeStatus('Preparing');
  } else if (connectorStatus === 'Preparing') {
    console.log('[SIM] Přechod na Charging...');
    changeStatus('Charging');
    send('StartTransaction', {
      connectorId: 1,
      idTag: '12345',
      meterStart: 0,
      timestamp: new Date().toISOString()
    });

  ws.on('StartTransaction', (payload) => {
  transactionId = payload.transactionId;
  console.log('📥 transactionId přijat od serveru:', transactionId);
  });

    startMetering();
  } else if (connectorStatus === 'Charging') {
    console.log('[SIM] Ukončení nabíjení..., transakce ID: ', transactionId);
    send('StopTransaction', {
      transactionId: transactionId,
      meterStop: Math.floor(energy * 1000),
      timestamp: new Date().toISOString(),
      idTag: '12345',
      reason: "EVDisconnected"
    });
    stopMetering();
    energy = 0;
    changeStatus('Available');
  }
});

const corsOptions = {
    origin: 'http://localhost:3200/',
    credentials: true,
    optionSuccessStatus: 200
}

app.use(cors());

app.use(function (req, res, next) {
    res.header('Access-Control-Allow-Origin', "*");
    res.header('Access-Control-Allow-Headers', true);
    res.header('Access-Control-Allow-Credentials', true);
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, PATCH, DELETE');
    next();
});
// API pro zobrazení stavu
app.get('/status', (req, res) => {
  res.json('{"ConnectorStatus": "' + connectorStatus + '"}');
});
app.get('/energy', (req, res) => {
  res.json('{"energy": "' + energy + '"}');
});

// Spuštění web serveru
app.listen(port, () => {
  console.log(`Web rozhraní běží na http://localhost:${port}`);
});
