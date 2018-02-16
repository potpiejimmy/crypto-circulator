const crypto = require('crypto');
const fetch = require('node-fetch');
const WebSocket = require('ws');
var fs = require("fs");

let refAsset;  // reference asset to start trading with

console.log("=== The Money Circulator 1.0.0 == " + new Date() + " ===\n");

if (!process.env.API_KEY || !process.env.API_SECRET) {
    console.log("Please set API_KEY and API_SECRET environment variables.");
    process.exit(1);
}

let prices = {};  // maps symbols to current prices (float)
let bids = {}; // maps trade symbols to current bids prices (highest bid for selling)
let assets = {};  // current assets
let coins = [];   // known coins
let circles = [];  // all circles, ordered by profitability
let circleNo = 0;  // current trading circle no
let valBefore = 0; // total REF_CUR value before trading
let valAfter = 0; // total REF_CUR value after trading
let tradeVolume = 0; // total theoretical trade volume (sum of all diff absolutes)
let commission = 0; // total commission
let listenKey; // web socket listen key
let lastOrderResult;
let tradeCount = 0; // number of trades traded in the current circle
let lastTimeout;
let cancellingTrade;

readPrices().then(allPrices => {
    // add all prices to our map
    allPrices.forEach(i => prices[i.symbol] = parseFloat(i.price));
    // read all account assets
    return readAssets();
})
.then(res => {
    // determine largest asset (refAsset):
    let largestAsset = -1;
    res.balances.forEach(i => {
        assets[i.asset]=parseFloat(i.free);
        let valueUsdt = valueInUsdt(i.asset);
        if (valueUsdt > largestAsset) {
            largestAsset = valueUsdt;
            refAsset = i.asset;
        }
    });
    console.log("You have " + assets[refAsset] + " " + refAsset + " for trading.");

    // build coin list for evaluation
    coins.push(refAsset); // REF_ASSET first in list
    res.balances.forEach(i => {
        if (i.asset!=refAsset) coins.push(i.asset);
    });
    console.log("Building all tradeable coin circles for " + coins.length + " assets");

    // register listen key for websocket:
    return fetch("https://api.binance.com/api/v1/userDataStream", {method: 'POST', headers: {"X-MBX-APIKEY": process.env.API_KEY}});
})
.then(res => res.json())
.then(listenKeyData => {

    listenKey = listenKeyData.listenKey;
    console.log("WebSocket listen key = "+listenKey);

    const ws = new WebSocket('wss://stream.binance.com:9443//ws/' + listenKey);
    ws.on('open', () => {
        console.log("WebSocket stream opened.");
        calculateTrades();
    });
    ws.on('close', () => {
        console.log('WebSocket disconnected.');
    });

    ws.on('message', data => {
        let e = JSON.parse(data);
        if (e.e == 'executionReport') {
            console.log(new Date() + " <<< " + data);
            handleExecutionReport(e);
        }
    });
})
.catch(err => {
    console.log(err);
});

function valueInUsdt(asset) {
    let result = assets[asset];
    if (asset == 'USDT') return result;
    result *= prices['BTCUSDT'];
    if (asset == 'BTC') return result; 
    return result * prices[asset+'BTC'];
}

function readPrices() {
    // get all current prices from the public API
    let url = "https://api.binance.com/api/v1/ticker/allPrices";
    console.log("Reading prices: GET " + url);
    return fetch(url).then(res => res.json());
}

function calculateTrades() {
    // re-read current prices
    return readPrices().then(allPrices => {
        allPrices.forEach(i => prices[i.symbol] = parseFloat(i.price));
        
        //for (let x=0; x<coins.length-2; x++) {
            let x=0; // build on REF_ASSET only
            for (let y=x+1; y<coins.length-1; y++) {
                for (let z=y+1; z<coins.length; z++) {
                    let p = priceForPair(coins[x],coins[y])*priceForPair(coins[y],coins[z])*priceForPair(coins[z],coins[x]);
                    if (p) {
                        circles.push({
                            p: p,
                            d: p < 1 ? 100/p-100 : 100*p-100,
                            c: [coins[x],coins[y],coins[z]]
                        })
                    }
                }
            }
        //}
        circles = circles.sort((a,b) => b.d - a.d);

        console.log("The top three circles are: ");
        for (let i=0; i<3; i++) {
            let c = circles[i];
            console.log((i+1)+": "+c.c[0]+"->"+c.c[1]+"->"+c.c[2]+"->"+c.c[0]+" = " + c.p);
        }

        circleNo = 0;
        fetchBids();

        // let circle = circles[circleNo];
        // if (circle.p < 1) {
        //     let swap = circle.c[1];
        //     circle.c[1] = circle.c[2];
        //     circle.c[2] = swap;
        // }
        // console.log("Okay, trading circle "+circle.c[0]+"->"+circle.c[1]+"->"+circle.c[2]+"->"+circle.c[0]+" to make "+circle.d.toFixed(2)+"% profit.");

        // return tradeNext();
    });
}

function fetchBids() {
    // fetch all bids and asks at once (open three requests if necessary)
    if (!bids[circles[circleNo].c[0]+circles[circleNo].c[1]])
        fetchBidsSingle(circles[circleNo].c[0], circles[circleNo].c[1]);

    if (!bids[circles[circleNo].c[1]+circles[circleNo].c[2]])
        fetchBidsSingle(circles[circleNo].c[1], circles[circleNo].c[2]);

    if (!bids[circles[circleNo].c[2]+circles[circleNo].c[0]])
        fetchBidsSingle(circles[circleNo].c[2], circles[circleNo].c[0]);
}

function fetchBidsSingle(a,b) {
    let symbol;
    if (prices[a+b]) {
        symbol = a+b;
    } else {
        symbol = b+a;
    }
    let url = "https://api.binance.com/api/v1/depth?limit=5&symbol="+symbol;
    console.log("Reading depth for "+symbol+": GET " + url);
    return fetch(url).then(res => res.json()).then(depth => {
        let bestBid = parseFloat(depth.bids[0][0]);
        let bestAsk = parseFloat(depth.asks[0][0]);
        bids[symbol] = (bestBid + bestAsk * 5) / 6;
        if (symbol == a+b) {
            bids[b+a] = 1/((bestAsk + bestBid * 5) / 6);
        } else {
            bids[a+b] = 1/((bestAsk + bestBid * 5) / 6);
        }
        if (isFetchBidsComplete()) evaluateCircle();
    })
    .catch(err => {
        console.log(err);
        process.exit(1);
    });
}

function isFetchBidsComplete() {
    return bids[circles[circleNo].c[0]+circles[circleNo].c[1]] &&
           bids[circles[circleNo].c[1]+circles[circleNo].c[2]] &&
           bids[circles[circleNo].c[2]+circles[circleNo].c[0]];
}

function evaluateCircle() {
    let c = circles[circleNo];
    let circleP = bids[c.c[0]+c.c[1]] * bids[c.c[1]+c.c[2]] * bids[c.c[2]+c.c[0]];
    console.log("Evaluate Forwards:  "+c.c[0]+"->"+c.c[1]+"->"+c.c[2]+"->"+c.c[0]+" = " + circleP);
    circleP = bids[c.c[0]+c.c[2]] * bids[c.c[2]+c.c[1]] * bids[c.c[1]+c.c[0]];
    console.log("Evaluate Backwards: "+c.c[0]+"->"+c.c[2]+"->"+c.c[1]+"->"+c.c[0]+" = " + circleP);

    circleNo++;
    if (circleNo == circles.length) {
        closeWebSocket().then(()=>{
            process.exit(0);
        });
    } else {
        fetchBids();
    }
}

function tradeNext() {
    printCircleValue(circles[circleNo]);
    cancellingTrade = false; // opening a new trade
    trade(circles[circleNo].c[tradeCount],circles[circleNo].c[(tradeCount+1)%3])
    .then(() => new Promise(resolve => lastTimeout = setTimeout(resolve, 60000)))
    .then(() => {
        console.log("Cancelling last orderId="+lastOrderResult.orderId);
        cancellingTrade = true; // cancelling
    
        let params = "symbol="+lastOrderResult.symbol+"&orderId="+lastOrderResult.orderId+"&timestamp="+Date.now();
        let url = "https://api.binance.com/api/v3/order?" + params + "&signature=" + sign(params);
        return fetch(url, {method: 'DELETE', headers: {"X-MBX-APIKEY": process.env.API_KEY}});
    })
    .then(res => res.json())
    .then(res => {
        console.log("Cancel result: " + JSON.stringify(res));
        let response = Promise.resolve();
        if (!cancellingTrade) return response; // new trade opened, do nothing
        if (listenKey) response = response.then(()=>closeWebSocket());
        response.then(() => {
            console.log("Done.\n");
            process.exit(0);
        });
    })
    .catch(err => {
        console.log(err);
        process.exit(1);        
    });
}

function handleExecutionReport(e) {
    let qtyA = parseFloat(e.l);
    let qtyB = qtyA * parseFloat(e.L);
    if (e.S == 'SELL') {
        assets[circles[circleNo].c[tradeCount]] -= qtyA;
        assets[circles[circleNo].c[(tradeCount+1)%3]] += qtyB
    } else {
        assets[circles[circleNo].c[tradeCount]] -= qtyB;
        assets[circles[circleNo].c[(tradeCount+1)%3]] += qtyA;
    }
    if (e.X == 'FILLED') {
        // order fulfilled completely, trade next
        clearTimeout(lastTimeout);
        tradeCount++;
        if (tradeCount == 3) {
            printCircleValue(circles[circleNo]);
            console.log("SUCCESS.");
        } else {
            tradeNext();
        }
    }
}

function closeWebSocket() {
    return fetch("https://api.binance.com/api/v1/userDataStream?listenKey"+listenKey, {method: 'DELETE', headers: {"X-MBX-APIKEY": process.env.API_KEY}})
    .then(res => {
        console.log("WebSocket listener key removed: " + JSON.stringify(res))
    });
}

function printCircleValue(c) {
    console.log();
    let circleVal = 0;
    for (let i=0; i<3; i++) {
        let refVal = assets[c.c[i]];
        if (c.c[i]!=refAsset) refVal *= prices[c.c[i]+refAsset] ? prices[c.c[i]+refAsset] : 1/prices[refAsset+c.c[i]];
        console.log(assets[c.c[i]] + " " + c.c[i] + " = " + refVal + " " + refAsset);
        circleVal += refVal;
    }
    console.log("Total circle value: " + circleVal + " " + refAsset);
}

function sign(params) {
    return crypto.createHmac('sha256', process.env.API_SECRET).update(params).digest('hex');
}

function priceForPair(a,b) {
    if (prices[a+b]) return prices[a+b];
    else if (prices[b+a]) return 1/prices[b+a];
    else return null;
}

function readAssets() {
    let params = "timestamp=" + Date.now();
    let url = "https://api.binance.com/api/v3/account?" + params + "&signature=" + sign(params);
    console.log("Reading account assets: GET " + url);
    return fetch(url, {headers: {"X-MBX-APIKEY": process.env.API_KEY}}).then(res => {
        if (res.status != 200) throw res.status + " " + res.statusText;
        return res.json();
    });
}

function trade(a,b) {
    let symbol;
    let side;
    let quantity;
    let avail;
    let price;
    if  (prices[a+b]) {
        symbol = a+b;
        side = 'SELL';
        avail = assets[a];
    } else {
        symbol = b+a;
        side = 'BUY';
        avail = assets[a] / prices[b+a];
    }
    quantity = parseFloat((avail*0.95).toPrecision(2));
    price = prices[symbol];
//   if (side=='BUY') price = parseFloat((price*1.01).toPrecision(4));
//    else price = parseFloat((price*0.995).toPrecision(4));
    console.log();
    console.log(side + " " + quantity + " " + symbol + " for " + price + " (market: " + prices[symbol] + ")...");

    let params = "symbol=" + symbol + "&side=" + side + "&type=LIMIT&quantity=" + quantity + "&newOrderRespType=FULL&price="+price+"&timeInForce=GTC&timestamp=" + Date.now();
    let url = "https://api.binance.com/api/v3/order/test?" + params + "&signature=" + sign(params);
    return fetch(url, {method:'POST', headers: {"X-MBX-APIKEY": process.env.API_KEY}})
           .then(res => res.json())
           .then(res => {
               if (res.code && res.code!=0) {
                   console.log(res.msg);
                   throw "Trade failure at " + a;
               } else {
                   lastOrderResult = res;
               }
            });
}
