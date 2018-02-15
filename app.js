const crypto = require('crypto');
const fetch = require('node-fetch');
const WebSocket = require('ws');

const REF_ASSET = "ETH";

console.log("=== The Money Circulator 1.0.0 == " + new Date() + " ===\n");

if (!process.env.API_KEY || !process.env.API_SECRET) {
    console.log("Please set API_KEY and API_SECRET environment variables.");
    process.exit(1);
}

let prices = {};  // maps symbols to current prices (float)
let assets = {};  // current assets
let coins = [];   // known coins
let circle = null;
let valBefore = 0; // total REF_CUR value before trading
let valAfter = 0; // total REF_CUR value after trading
let tradeVolume = 0; // total theoretical trade volume (sum of all diff absolutes)
let commission = 0; // total commission
let listenKey; // web socket listen key

// read all account assets
readAssets()
.then(res => {
    coins.push(REF_ASSET); // REF_ASSET first in list
    res.balances.forEach(i => {
        if (i.asset!=REF_ASSET) coins.push(i.asset);
        assets[i.asset]=parseFloat(i.free);
    });
    console.log("Found " + coins.length + " assets. You have " + assets[REF_ASSET] + " " + REF_ASSET);

    // get all current prices from the public API
    let url = "https://api.binance.com/api/v1/ticker/allPrices";
    console.log("Reading prices: GET " + url);
    return fetch(url);
})
.then(res => res.json())
.then(allPrices => {
    // add all prices to our map
    allPrices.forEach(i => prices[i.symbol] = parseFloat(i.price));
    let circles = [];
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

    circle = circles[0];
    if (circle.p < 1) {
        let swap = circle.c[1];
        circle.c[1] = circle.c[2];
        circle.c[2] = swap;
    }
    console.log("Okay, trading circle "+circle.c[0]+"->"+circle.c[1]+"->"+circle.c[2]+"->"+circle.c[0]+" to make "+circle.d.toFixed(2)+"% profit.");

    // register listen key for websocket:
    return fetch("https://api.binance.com/api/v1/userDataStream", {method: 'POST', headers: {"X-MBX-APIKEY": process.env.API_KEY}});
})
.then(res => res.json())
.then(listenKeyData => {

    listenKey = listenKeyData.listenKey;
    console.log("WebSocket listen key = "+listenKey);

    const ws = new WebSocket('wss://stream.binance.com:9443//ws/' + listenKey);
    ws.on('open', function open() {
        console.log("WebSocket stream opened.");
    });
    ws.on('close', function close() {
        console.log('WebSocket disconnected.');
    });

    ws.on('message', function incoming(data) {
        console.log("<<< " + data);
    });

    printCircleValue(circle);
    return trade(circle.c[0],circle.c[1]);
})
// .then(()=> {
//     printCircleValue(circle);
//     return trade(circle.c[1],circle.c[2]);
// })
// .then(()=> {
//     printCircleValue(circle);
//     return trade(circle.c[2],circle.c[0]);
// })
// .then(()=> {
//     printCircleValue(circle);
// })
.then(()=> {
//     // now, read all account assets again (after trading)
//     return readAssets();
// })
// .then(res => {
    console.log("Done.");
})
.catch(err => {
    console.log(err);
})
.finally(() => {
    // delete listen key for websocket:
    fetch("https://api.binance.com/api/v1/userDataStream?listenKey"+listenKey, {method: 'DELETE', headers: {"X-MBX-APIKEY": process.env.API_KEY}});
});

function printCircleValue(c) {
    console.log();
    let circleVal = 0;
    for (let i=0; i<3; i++) {
        let refVal = assets[c.c[i]];
        if (c.c[i]!=REF_ASSET) refVal *= prices[c.c[i]+REF_ASSET] ? prices[c.c[i]+REF_ASSET] : 1/prices[REF_ASSET+c.c[i]];
        console.log(assets[c.c[i]] + " " + c.c[i] + " = " + refVal + " " + REF_ASSET);
        circleVal += refVal;
    }
    console.log("Total circle value: " + circleVal + " " + REF_ASSET);
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
    url = "https://api.binance.com/api/v3/account?" + params + "&signature=" + sign(params);
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
    if (side=='BUY') price = parseFloat((price*1.005).toPrecision(4));
    else price = parseFloat((price*0.995).toPrecision(4));
    process.stdout.write(side + " " + quantity + " " + symbol + " for " + price + " (market: " + prices[symbol] + ")...");

    let params = "symbol=" + symbol + "&side=" + side + "&type=LIMIT&quantity=" + quantity + "&newOrderRespType=FULL&price="+price+"&timeInForce=FOK&timestamp=" + Date.now();
    url = "https://api.binance.com/api/v3/order?" + params + "&signature=" + sign(params);
    return fetch(url, {method:'POST', headers: {"X-MBX-APIKEY": process.env.API_KEY}})
           .then(res => res.json())
           .then(res => {
               if (res.code && res.code!=0) {
                   console.log(res.msg);
                   throw "Trade failure at " + a;
               } else {
                   console.log(res.status);
                   if (res.fills && res.fills.length) {
                        res.fills.forEach(i => {
                            let qtyA = parseFloat(i.qty);
                            let qtyB = qtyA * parseFloat(i.price);
                            if (side == 'SELL') {
                                assets[a] -= qtyA;
                                assets[b] += qtyB
                            } else {
                                assets[a] -= qtyB;
                                assets[b] += qtyA;
                            }
                            //commission += parseFloat(i.commission);
                        });
                   } else {
                       throw "Unsuccessful trade at " + a;
                   }
               }
            });
}
