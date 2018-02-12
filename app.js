var crypto = require('crypto');
var fetch = require('node-fetch');

console.log("=== The Money Circulator 1.0.0 == " + new Date() + " ===\n");

if (!process.env.API_KEY || !process.env.API_SECRET) {
    console.log("Please set API_KEY and API_SECRET environment variables.");
    process.exit(1);
}

let prices = {};  // maps symbols to current prices (float)
let coins = [];   // known coins
let circles = [];
let valBefore = 0; // total REF_CUR value before trading
let valAfter = 0; // total REF_CUR value after trading
let tradeVolume = 0; // total theoretical trade volume (sum of all diff absolutes)
let commission = 0; // total commission

// read all account assets
readAssets()
.then(res => res.json())
.then(res => {
    res.balances.forEach(i => coins.push(i.asset));
    console.log("Found " + coins.length + " assets");

    // get all current prices from the public API
    let url = "https://api.binance.com/api/v1/ticker/allPrices";
    console.log("Reading prices: GET " + url);
    return fetch(url)
})
.then(res => res.json())
.then(allPrices => {
    // add all prices to our map
    allPrices.forEach(i => prices[i.symbol] = parseFloat(i.price));
    for (let x=0; x<coins.length-2; x++) {
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
    }
    circles = circles.sort((a,b) => b.d - a.d);
    for (let i=0; i<5; i++) {
        let c = circles[i];
        console.log(c.c[0]+"->"+c.c[1]+"->"+c.c[2]+"->"+c.c[0]+" = " + c.p);
    }
})
.then(()=> {
//     // now, read all account assets again (after trading)
//     return readAssets();
// })
// .then(res => res.json())
// .then(res => {
    console.log("Done.");
})
.catch(err => {
    console.log(err);
});

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
    return fetch(url, {headers: {"X-MBX-APIKEY": process.env.API_KEY}});
}

function retrade(coin) {
    if (coin.asset === REF_CUR) return Promise.resolve();
    let diff = coin.refVal - totalAverage;
    let absDiff = Math.abs(diff);
    totalTradeVolume += absDiff;
    let quantity = absDiff/prices[coin.asset + REF_CUR];
    quantity = parseFloat(quantity.toPrecision(2));
    let side = (diff > 0 ? 'SELL' : 'BUY');
    process.stdout.write(side + " " + absDiff + " " + REF_CUR + " of " + coin.asset + " = " + quantity + "...");

    let params = "symbol=" + coin.asset + REF_CUR + "&side=" + side + "&type=MARKET&quantity=" + quantity + "&newOrderRespType=FULL&timestamp=" + Date.now();
    url = "https://api.binance.com/api/v3/order/test?" + params + "&signature=" + sign(params);
    return fetch(url, {method:'POST', headers: {"X-MBX-APIKEY": process.env.API_KEY}})
           .then(res => res.json())
           .then(res => {
               if (res.code && res.code!=0) console.log(res.msg);
               else {
                   console.log("OK");
                   if (res.fills) {
                        res.fills.forEach(i => {
                            totalTradeVolumeActual += parseFloat(i.qty) * parseFloat(i.price);
                            totalCommission += parseFloat(i.commission);
                        });
                   }
               }
            });
}
