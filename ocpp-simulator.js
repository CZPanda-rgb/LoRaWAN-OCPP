const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');
const readline = require('readline');
const express = require('express');
const app = express();
const cors = require('cors');
const port = 3200;



const chargePointId = 'yourEVSEid';
const ocppUrl = `ws://example.com:port/something/${chargePointId}`; // Change according to your server
const MeteoScientificAPIkey = 'yourMeteoScientificAPIKey';
const DevEUI = 'yourDevEUI';

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

let ws = new WebSocket(ocppUrl, 'ocpp1.6');
let messageId = 1;
let connectorStatus = 'Available';
let transactionId = null;
let idTag = null;
let energy = 0;
let meterInterval = 30;
let heartbeatInterval = 10; // default fallback (sekundy)
let maxCurrent = 10; //default 10 Amperes
let meterActive;
let TxQueue = "", pointerTxQueue, initiateSend = 0;
const OcppMessagesTypes = ["BootNotification", "Heartbeat", "StartTransaction", "StopTransaction", "RemoteStartTransaction", "RemoteStopTransaction", "MeterValueSampleInterval", "HeartbeatInterval", "MeterValueSampleInterval", "CurrentLimit", "PowerLimit", "CurrentLimit", "PowerLimit", "Energy.Active.Import.Register", "ConnectorStatus"];
// memory for storing incoming callIds
const pendingCalls = [];
let OcppMessageTypeVariable = 0; //bitmask of OCPP message types according to table eg. index 0 = BootupNotification, index 1 = Heartbeat ...

const send = (action, payload) => {
  const msgId = uuidv4();
  const frame = [2, msgId, action, payload];
  ws.send(JSON.stringify(frame));
  return msgId;
};
function getUtcMidnightToday() {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}
function sendConfigurationWSresponse(respWS){
  ws.send(JSON.stringify(respWS, null, 2));
  console.log(`Response to GetConfiguration:`, JSON.stringify(respWS, null, 2));
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

async function sendDownlink(fPort = 1, confirmed = false, flush = false) {
  const url = `https://console.meteoscientific.com/api/devices/${DevEUI}/queue`;
  console.log(`Contents of TxQueue (LoRaWAN Payload): ${TxQueue}`);
  setTimeout(async () => {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        "Accept": "application/json",
        "Authorization": `Bearer ${MeteoScientificAPIkey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        queueItem: {
          data: TxQueue,
          fPort,
          confirmed,
          flushQueue: flush
        }
      })
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`Error occured while sending downlink: ${response.status} ${errorBody}`);
    }

    console.log("Downlink sent succesfully: ", await response.json());
    TxQueue = "";
    initiateSend = 0;
  }, 5000);
}

function hexToBase64(hex) {
  // převede hex string na buffer
  const buffer = Buffer.from(hex, "hex");
  // převede buffer na Base64 string
  return buffer.toString("base64");
}

function connectOCPP() {
  ws.on('open', () => {
    console.log('[OCPP] Connected to OCPP server, sending BootNotification...');

  // Po připojení a úspěšném BootNotification
    send('BootNotification', {
      chargePointModel: 'SampleModel',
      chargePointVendor: 'Sample EVSEs'
    }, () => {
      // server odpověděl
      heartbeatInterval = responsePayload.interval || 60;

    });
  });
}
connectOCPP();
ws.on('error', (err) => {
    console.log('Connection error, try again in 5 seconds', err.message);
    setTimeout(connectOCPP, 5000);
  });
ws.on('message', (data) => {
  const msg = JSON.parse(data);
  if (msg[0] === 3) {
    const [_, id, payload] = msg;
    console.log(`[OCPP] Response (${id}):`, payload);

    // Pokud odpověď na BootNotification obsahuje interval
    if (payload.interval) {
      heartbeatInterval= payload.interval; //asi by chtelo predat dal na Lorawan zarizeni
      console.log(`[OCPP] Hearthbeat interval is now set: ${heartbeatInterval}s`);
    }
    if (payload.transactionId){
      transactionId = payload.transactionId;
      console.log(`[OCPP] Prijali jsme odpoved na StartTransaction a TransactionId je : ${transactionId}`);
    }  
  } else if (msg[0] === 2) {
    const [_, callId, action, payload] = msg;
    console.log(`[OCPP] Incoming request ${action}, obsah: ${JSON.stringify(payload)}`);

    if (action === 'ChangeConfiguration') {
      if (payload.key === 'MeterValueSampleInterval') {
      const value = parseInt(payload.value, 10);
      if (!isNaN(value) && value > 0) {
      meterInterval = value;
      try{
          if (meterInterval <= 1275){
            const hexToSend = "06";
            let meterIntervalHexFormated = meterInterval.toString(16);
            meterIntervalHexFormated = meterIntervalHexFormated.padStart(2, "0");
            OcppMessageTypeVariable |= (1 << 6);
            TxQueue += hexToBase64(hexToSend + meterIntervalHexFormated); //send request to MeteoScientific
            if (initiateSend == 0){
                sendDownlink();
                initiateSend = 1;
            }
          }
        }
        catch{
          console.log('MeterValueSampleInterval is higher than 1275 A or meteoscientific console is not available');
        }
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
  else if (payload.key === 'HeartbeatInterval') {
      const value = parseInt(payload.value, 10);
      if (!isNaN(value) && value > 0) {
      heartbeatInterval = value;
      try{
          if (meterInterval <= 1275){
            const hexToSend = "07";
            let heartbeatIntervalDivied = heartbeatInterval / 5;
            let heartbeatIntervalHexFormated = heartbeatIntervalDivied .toString(16);
            heartbeatIntervalHexFormated = heartbeatIntervalHexFormated.padStart(2, "0");
            OcppMessageTypeVariable |= (1 << 7);
            TxQueue += hexToBase64(hexToSend + heartbeatIntervalHexFormated); //send request to MeteoScientific
            if (initiateSend == 0){
                sendDownlink();
                initiateSend = 1;
            }
          }
        }
        catch{
          console.log('HeartbeatInterval is higher than 1275 seconds or meteoscientific console is not available');
        }
      console.log(`zmenen interval Heartbeat interval na ${heartbeatInterval}s`);
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
      let sendWSImmediately = 1;
      for (const key of requestedKeys) {
        if (key === 'HeartbeatInterval') {
          response.configurationKey.push({
            key: 'HeartbeatInterval',
            readonly: false,
            value: heartbeatInterval
          });
        }
        else if (key === 'MeterValueSampleInterval') {
          sendWSImmediately = 0;
          const hexToSend = "08";
          OcppMessageTypeVariable |= (1 << 8);
          TxQueue += hexToBase64(hexToSend); //send request to MeteoScientific
          if (initiateSend == 0){
                sendDownlink();
                initiateSend = 1;
          }
        } 
        else {
          response.unknownKey.push(key);
        }
      }
      pendingCalls.push({ OcppMessageTypeVariable, callId, timestamp: Date.now() });
      console.log("Call ID has been saved together with variable storing info which OCPP recognised variables has been polled, the variable is: ");
      console.log(OcppMessageTypeVariable.toString(2));
      OcppMessageTypeVariable = 0;
      if(sendWSImmediately === 1){  //exists because getHeartbeatInterlval is an exceptional case, where we dont ask LoRawan device for an answer but send an immediate answer
        const responseMessage = [3, callId, response];
        sendConfigurationWSresponse(responseMessage);
        
      }
      
      }
      else if (action === 'GetCompositeSchedule') {//so far we do not send request to the EVSE and simply believe, that EVSE and server side have the same electric current value
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
      console.log(`Response to GetConfiguration:`, JSON.stringify(responseMessage, null, 2));
    }
    else if (action === 'SetChargingProfile'){
      try{
        if (payload.csChargingProfiles.chargingSchedule.chargingRateUnit === 'A' ){
          maxCurrent = payload.csChargingProfiles.chargingSchedule.chargingSchedulePeriod[0].limit;
          try{
          if (maxCurrent <= 255){
            const hexToSend = "09";
            let maxCurrentHexFormated = maxCurrent.toString(16);
            maxCurrentHexFormated = maxCurrentHexFormated.padStart(2, "0");
            TxQueue += hexToBase64(hexToSend + maxCurrentHexFormated); //add to TxQueue
            if (initiateSend == 0){
                sendDownlink();
                initiateSend = 1;
            }
          }
        }
        catch{
          console.log('Max current is higher than 255 A or meteoscientific console is not available');
        }
        }
        const responseMessage = [3, callId, {status: "Accepted"}];
        ws.send(JSON.stringify(responseMessage, null, 2));
        console.log(`Response to GetConfiguration:`, JSON.stringify(responseMessage, null, 2));
      }
      catch{
        console.log(`Max current could not be read from request SetChargingProfile`);
      }
    }
    else if(action === 'RemoteStartTransaction'){
      try{
        idTag = payload.idTag;
      }
      catch{
        console.log("idTag is missing along with RemoteStartTransaction message");
      }
      const responseMessage = [3, callId, {status: "Accepted"}];
      ws.send(JSON.stringify(responseMessage, null, 2));
      console.log(`Response to RemoteStartTransaction:`, JSON.stringify(responseMessage, null, 2));
      send('StartTransaction', {
      connectorId: 1,
      idTag: idTag,
      meterStart: energy,
      timestamp: new Date().toISOString()
    });
      changeStatus('Charging');
      TxQueue += hexToBase64("04");
      if (initiateSend == 0){
        sendDownlink();
        initiateSend = 1;
      }
    }
    else if(action === 'RemoteStopTransaction'){
      //if(payload.transactionId === transactionId){
        const responseMessage = [3, callId, {status: "Accepted"}];
        ws.send(JSON.stringify(responseMessage, null, 2));
        console.log(`Response to RemoteStopTransaction:`, JSON.stringify(responseMessage, null, 2));
        changeStatus('Available');
        TxQueue += hexToBase64("05");
        if (initiateSend == 0){
                sendDownlink();
                initiateSend = 1;
            }
      //}
    }
  }
});

const corsOptions = {
    origin: 'http://localhost:3200/',
    credentials: true,
    optionSuccessStatus: 200
}

app.use(cors());
app.use(express.json());


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

// Endpoint where LoRaWAN console will send requests
app.post("/lorawan", (req, res) => {
  const body = req.body;
  const payloadLorawan = body?.data;
  console.log("Request from LoRaWAN console received:");
  console.log("Headers:", req.headers);
  console.log("Body:", req.body);

  //tento blok presunout do odpovedi od MeteoScientific casti kodu + ohlidat jestli pozadavek obsahuje zpravy co umime odpovedet hned ze strany serveru a kdyz ne tak pockat s odpovedi az budeme mit vsechny odpovedi z Lorawan zarizeni
    const buf = Buffer.from(body.data, "base64");
    const response = {
        configurationKey: [],
        unknownKey: []
      };
    let RxBufPointer = 0;
    while (RxBufPointer < buf.length){
      if(buf[RxBufPointer] === 1){
        send('Heartbeat', {});
        console.log(`[OCPP] Sending heartbeat, interval: ${heartbeatInterval}s`);
        RxBufPointer++;
      }
      else if (buf[RxBufPointer] === 3) { //StopTransaction LoRaWAN -> OCPP Server
        // First check, if we have 5 bytes: opcode + 4 data bytes
        if (RxBufPointer + 4 >= buf.length) {
          console.log(`[OCPP] ERROR: StopTransaction – not enough data. Expecting 5 bytes, only ${buf.length - RxBufPointer} received.`);
          break; // nebo RxBufPointer++; podle toho, jestli chceš pokračovat, ale nehavarovat
        }

        try {
          // safely load 4 bytes
          const b1 = buf[RxBufPointer + 1];
          const b2 = buf[RxBufPointer + 2];
          const b3 = buf[RxBufPointer + 3];
          const b4 = buf[RxBufPointer + 4];

          const energyToSend =
            (b1 << 24) |
            (b2 << 16) |
            (b3 << 8) |
            (b4);

          console.log(`[OCPP] Received StopTransaction with energy value ${energyToSend} Wh`);

          energy = energyToSend;

          RxBufPointer += 5;

          send(
          'StopTransaction', { 
            transactionId: transactionId,
            idTag: idTag,
            meterStop: energy,
            timestamp: new Date().toISOString(),
            reason: "Remote"
            }
          );

        } catch (err) {
          console.log(`[PROGRAM] ERROR in Energy.Active.Import.Register parser: ${err.message}`);
          RxBufPointer += 1; // move pointer, so that we are not stuck in infinite loop
        }
      }
      else if (buf[RxBufPointer] === 8 && buf[RxBufPointer + 1]!== undefined){
        const match = pendingCalls.find(entry => entry.OcppMessageTypeVariable === 0b100000000);
        response.configurationKey.push({
        key: 'MeterValueSampleInterval',
        readonly: false,
        value: buf[RxBufPointer + 1] * 5
        });
        const responseMessage = [3, match.callId, response];
        sendConfigurationWSresponse(responseMessage);
        RxBufPointer += 2;
      }
      else if(buf[RxBufPointer] === 11){
        let dump = buf[RxBufPointer];
        dump = buf[RxBufPointer + 1];
        console.log(`[OCPP] Received CurrentLimit`);
        RxBufPointer +=2;
      }
      else if(buf[RxBufPointer] === 12){
        let dump = buf[RxBufPointer];
        dump = buf[RxBufPointer + 1];
        console.log(`[OCPP] Received PowerLimit`);
        RxBufPointer +=2;
      }
      else if (buf[RxBufPointer] === 13) {
        // First check, if we have 5 bytes: opcode + 4 data bytes
        if (RxBufPointer + 4 >= buf.length) {
          console.log(`[OCPP] ERROR: Energy.Active.Import.Register – not enough data. Expecting 5 bytes, only ${buf.length - RxBufPointer} received.`);
          break; // nebo RxBufPointer++; podle toho, jestli chceš pokračovat, ale nehavarovat
        }

        try {
          // safely load 4 bytes
          const b1 = buf[RxBufPointer + 1];
          const b2 = buf[RxBufPointer + 2];
          const b3 = buf[RxBufPointer + 3];
          const b4 = buf[RxBufPointer + 4];

          const energyToSend =
            (b1 << 24) |
            (b2 << 16) |
            (b3 << 8) |
            (b4);

          console.log(`[OCPP] Received Energy.Active.Import.Register: ${energyToSend} Wh`);

          energy = energyToSend;

          RxBufPointer += 5;

          send("MeterValues", {
            connectorId: 1,
            transactionId: transactionId,
            meterValue: [
              {
                timestamp: new Date().toISOString(),
                sampledValue: [
                  {
                    value: energy,
                    unit: "Wh",
                    measurand: "Energy.Active.Import.Register",
                  },
                ],
              },
            ],
          });

        } catch (err) {
          console.log(`[PROGRAM] ERROR in Energy.Active.Import.Register parser: ${err.message}`);
          RxBufPointer += 1; // move pointer, so that we are not stuck in infinite loop
        }
      }

      /*if(buf[RxBufPointer] === 12){
        let dump = buf[RxBufPointer];
        dump = buf[RxBufPointer + 1];
        console.log(`[OCPP] Received PowerLimit`);
        RxBufPointer +=2;
      }*/
      else if(buf[RxBufPointer] === 14){
        let dump = buf[RxBufPointer];
        let connStat = buf[RxBufPointer + 1];
        console.log(`[OCPP] Received ConnectorStatus`);
        if(connStat === 1){
          changeStatus('Available');
        }
        else if(connStat === 2){
          changeStatus('Preparing');
        }
        else if(connStat === 3){
          changeStatus('Charging');
        }
        else {
          changeStatus('Unavailable');
        }
        
        RxBufPointer +=2;
      }
    }
  // always send 2xx response, otherwise TTN marks request as failed
  res.status(200).send("OK");
});


// Launch web server
app.listen(port, () => {
  console.log(`Web interface is running on http://localhost:${port}`);
});
