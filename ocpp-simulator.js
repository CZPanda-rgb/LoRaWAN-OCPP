const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');
const readline = require('readline');
const express = require('express');
const app = express();
const cors = require('cors');
const port = 3200;



const chargePointId = 'pureWSEVSE';
const ocppUrl =  // Change according to your server
const MeteoScientificAPIkey = 'fillmein';
const DevEUI = 'fillmein';

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
let maxCurrent = 10; //default 10 Amperes
let meterActive;

const send = (action, payload) => {
  const msgId = uuidv4();
  const frame = [2, msgId, action, payload];
  ws.send(JSON.stringify(frame));
  return msgId;
};
function startHeartbeatLoop() {
  setInterval(() => {
    send('Heartbeat', {});
    console.log(`[OCPP] Sending heartbeat, interval: ${hearthbeatInterval}s`);
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
  if (meterActive) clearInterval(meterActive);
  if (meterInterval < 1) {
    meterInterval = 1; // interval less than 1 second is too small
  }
  meterActive = setInterval(() => {
    energy += 100; // each x seconds add 0.1 kWh (simulation)
    send('MeterValues', {
      connectorId: 1,
      transactionId: transactionId,
      meterValue: [{
        timestamp: new Date().toISOString(),
        sampledValue: [{
          value: energy.toFixed(0),
          unit: 'Wh',
          measurand: 'Energy.Active.Import.Register',
        }]
      }]
    });
    console.log(`Meter value has been sent: ${energy} Wh, MeterValueSample interval is: ${meterInterval} s`);
  }, meterInterval * 1000);
};

const stopMetering = () => {
  clearInterval(meterActive);
  meterActive = null;
};

async function sendDownlink(payloadBase64, fPort = 1, confirmed = false, flush = false) {
  const url = `https://console.meteoscientific.com/api/devices/${DevEUI}/queue`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      "Accept": "application/json",
      "Authorization": `Bearer ${MeteoScientificAPIkey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      queueItem: {
        data: payloadBase64,
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
}
function hexToBase64(hex) {
  // převede hex string na buffer
  const buffer = Buffer.from(hex, "hex");
  // převede buffer na Base64 string
  return buffer.toString("base64");
}

ws.on('open', () => {
  console.log('[OCPP] Connected to OCPP server, sending BootNotification...');

// Po připojení a úspěšném BootNotification
send('BootNotification', {
  chargePointModel: 'Krystof Charge 1',
  chargePointVendor: 'Krystof EVSEs'
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
      console.log(`[OCPP] Hearthbeat interval is now set: ${hearthbeatInterval}s`);
      startHeartbeatLoop();
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
      if(connectorStatus === 'Charging'){
        stopMetering();
        startMetering(); //new interval gets applied
      }
      try{
          if (meterInterval <= 1275){
            const hexToSend = "06";
            let meterIntervalHexFormated = meterInterval.toString(16);
            meterIntervalHexFormated = meterIntervalHexFormated.padStart(2, "0");
            sendDownlink(hexToBase64(hexToSend + meterIntervalHexFormated)); //send request to MeteoScientific
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
        } else if (key === 'HearthbeatInterval') {
          response.configurationKey.push({
            key: 'HeartbeatInterval',
            readonly: false,
            value: heartbeatInterval
          });
        }
        else {
          response.unknownKey.push(key);
        }
      }
      const responseMessage = [3, callId, response];
      ws.send(JSON.stringify(responseMessage, null, 2));
      console.log(`Response to GetConfiguration:`, JSON.stringify(responseMessage, null, 2));
      }
      else if (action === 'GetCompositeSchedule') {//so far we do not send request to the EVSE and simply believe, that EVSE and server side have the same current value
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
            sendDownlink(hexToBase64(hexToSend + maxCurrentHexFormated)); //send request to MeteoScientific
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
        console.log("chybí idTag u RemoteStartTransaction");
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
      startMetering();
      sendDownlink(hexToBase64("05"));
    }
    else if(action === 'RemoteStopTransaction'){
      if(payload.transactionId === transactionId){
        const responseMessage = [3, callId, {status: "Accepted"}];
        ws.send(JSON.stringify(responseMessage, null, 2));
        console.log(`Response to RemoteStopTransaction:`, JSON.stringify(responseMessage, null, 2));
        changeStatus('Available');
        stopMetering();
        sendDownlink(hexToBase64("06"));
        send(
          'StopTransaction', {
            transactionId: transactionId,
            idTag: idTag,
            meterStop: energy,
            timestamp: new Date().toISOString(),
            reason: "Remote"
          }
        );
      }
    }
  }
});

rl.on('line', () => {
  if (connectorStatus === 'Available') {
    console.log('[SIM] Transition to Preparing...');
    changeStatus('Preparing');
  } else if (connectorStatus === 'Preparing') {
    console.log('[SIM] Transition to Charging...');
    changeStatus('Charging');
    idTag = '12345';
    send('StartTransaction', {
      connectorId: 1,
      idTag: idTag,
      meterStart: energy,
      timestamp: new Date().toISOString()
    });
    startMetering();
    } 
    else if (connectorStatus === 'Charging') {
    console.log('[SIM] Charging cancelled..., transakce ID: ', transactionId);
    idTag = '12345';
    send('StopTransaction', {
      transactionId: transactionId,
      meterStop: Math.floor(energy * 1000),
      timestamp: new Date().toISOString(),
      idTag: idTag,
      reason: "EVDisconnected"
    });
    stopMetering();
    changeStatus('Available');
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
  console.log("Přišel request z LoRaWAN:");
  console.log("Headers:", req.headers);
  console.log("Body:", req.body);

  // můžeš uložit do DB, poslat dál, zpracovat payload atd.
  
  // always send 2xx response, otherwise TTN marks request as failed
  res.status(200).send("OK");
});


// Launch web server
app.listen(port, () => {
  console.log(`Web interface is running on http://localhost:${port}`);
});
