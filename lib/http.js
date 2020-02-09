/*!
 * http.js - http server for hnscan
 * Copyright (c) 2017-2018, Christopher Jeffrey (MIT License).
 * Copyright (c) 2018-2019, Handshake Alliance Developers (MIT License).
 * https://github.com/handshakealliance/hnscan-backend
 */

"use strict";

const { Server } = require("bweb");
const Network = require("hsd").protocol.Network;
const Validator = require("bval");
const { base58 } = require("bstring");
const random = require("bcrypto/lib/random");
const sha256 = require("bcrypto/lib/sha256");
const assert = require("bsert");
const version = require("../package.json").version;
const protocol = require("../package.json").protocol;
const bio = require("bufio");
const util = require("./util.js");
const rules = require("hsd/lib/covenants/rules");
const Amount = require("hsd/lib/ui/amount");
const NameState = require("hsd/lib/covenants/namestate");
const pkg = require("hsd").pkg;
const geoip = require("geoip-lite");

const { Address, TX } = require("hsd");

/**
 * HTTP
 * @alias module:hnscan.HTTP
 */

class HTTP extends Server {
  /**
   * Create an http server.
   * @constructor
   * @param {Object} options
   */

  constructor(options) {
    super(new HTTPOptions(options));

    this.network = this.options.network;
    this.logger = this.options.logger.context("hnscan-http");
    this.hdb = this.options.hdb;
    this.client = this.options.client;
    this.host = this.options.host;
    this.port = this.options.port;
    this.ssl = this.options.ssl;
    this.node = this.options.node;
    this.chain = this.node.chain;
    this.fees = this.node.fees;
    this.mempool = this.node.mempool;
    // TODO: remove rpc call for names
    this.rpc = this.node.rpc;
    this.hnscan = this.options.hnscan;

    this.init();
  }

  /**
   * Initialize http server.
   * @private
   */

  init() {
    this.on("request", (req, res) => {
      if (req.method === "POST" && req.pathname === "/") return;

      this.logger.debug(
        "Request for method=%s path=%s (%s).",
        req.method,
        req.pathname,
        req.socket.remoteAddress
      );
    });

    this.on("listening", address => {
      this.logger.info(
        "Hnscan HTTP server listening on %s (port=%d).",
        address.address,
        address.port
      );
    });

    this.initRouter();
  }

  /**
   * Initialize routes.
   * @private
   */

  initRouter() {
    if (this.options.cors) this.use(this.cors());

    if (!this.options.noAuth) {
      this.use(
        this.basicAuth({
          hash: sha256.digest,
          password: this.options.apiKey,
          realm: "hnscan"
        })
      );
    }

    this.use(
      this.bodyParser({
        type: "json"
      })
    );

    this.use(this.jsonRPC());
    this.use(this.router());

    this.error((err, req, res) => {
      const code = err.statusCode || 500;
      res.json(code, {
        error: {
          type: err.type,
          code: err.code,
          message: err.message
        }
      });
    });

    this.get("/summary", async (req, res) => {
      const totalTX = this.mempool ? this.mempool.map.size : 0;
      const size = this.mempool ? this.mempool.getSize() : 0;
      // const registeredNames = sortArr(await this.rpc.getNames([]), "close");
      const start = process.hrtime();

      const nameCount = await this.hnscan.getNameCount(this.chain.height);

      const diff = process.hrtime(start);

      const NS_PER_SEC = 1e9;

      console.log(
        `Benchmark took ${diff[0] * NS_PER_SEC + diff[1]} nanoseconds`
      );

      res.json(200, {
        network: this.network.type,
        chainWork: this.chain.tip.chainwork.toString("hex", 64),
        difficulty: toDifficulty(this.chain.tip.bits),
        hashrate: await this.getHashRate(120),
        unconfirmed: totalTX,
        unconfirmedSize: size,
        // Getting names doubles response time - any way to speed this up?
        // @todo make this activeNames
        registeredNames: nameCount
      });
    });

    this.get("/status", async (req, res) => {
      let addr = this.node.pool.hosts.getLocal();

      if (!addr) addr = this.node.pool.hosts.address;

      let sent = 0;
      let recv = 0;

      for (let peer = this.node.pool.peers.head(); peer; peer = peer.next) {
        sent += peer.socket.bytesWritten;
        recv += peer.socket.bytesRead;
      }

      res.json(200, {
        host: addr.host,
        port: addr.port,
        key: addr.getKey("base32"),
        network: this.network.type,
        progress: this.chain.getProgress(),
        version: pkg.version,
        agent: this.node.pool.options.agent,
        connections: this.node.pool.peers.size(),
        height: this.chain.height,
        difficulty: toDifficulty(this.chain.tip.bits),
        uptime: this.node.uptime(),
        totalBytesRecv: recv,
        totalBytesSent: sent
      });
    });

    // Blocks in bulk by specified number
    // Default = 10; Max = 50
    this.get("/blocks", async (req, res) => {
      const valid = Validator.fromRequest(req);
      const tip = this.chain.height;
      const limit = valid.uint("limit", 25);
      const offset = valid.uint("offset", 0);
      const start = tip - offset;

      enforce(limit <= 50, "Too many blocks requested. Max of 50.");
      enforce(start >= 0, "Offset too large.");
      enforce(!this.chain.options.spv, "Cannot get block in SPV mode.");

      let end = start - limit;

      if (end < 0) {
        end = -1;
      }

      let blocks = [];
      for (let i = start; i > end; i--) {
        //@todo performance - parrallize this.
        const block = await this.hnscan.getBlock(i);

        blocks.push(block);
      }

      res.json(200, {
        total: tip + 1,
        offset,
        limit,
        result: blocks
      });
    });

    this.get("/blocks/:height", async (req, res) => {
      const valid = Validator.fromRequest(req);
      const height = valid.u32("height");

      enforce(height != null, "height required.");

      const block = await this.hnscan.getBlock(height);

      if (!block) {
        res.json(404);
        return;
      }

      res.json(200, block);
    });

    this.get("/txs", async (req, res) => {
      const valid = Validator.fromRequest(req);
      const height = valid.u32("height");
      const address = valid.str("address");
      //@todo remove the offset
      const offset = valid.u32("offset", 0);
      const page = valid.u32("p", 1);
      const limit = valid.u32("limit", 25);

      // TODO: Needs Fixing
      // enforce(height != null || address != null, "height required.");

      //@todo this block can definitely be cleaned up considering they are both returning the same variable names.
      if (height) {
        const [txs, total] = await this.hnscan.getTransactionsByHeight(
          height,
          offset,
          limit
        );

        res.json(200, {
          total,
          result: txs
        });
      } else if (address) {
        //@todo catch this and return 404.
        let addr = Address.fromString(address, this.network.type);
        const [txs, total] = await this.hnscan.getTransactionsByAddress(
          addr,
          offset,
          limit
        );
        res.json(200, {
          total,
          offset,
          limit,
          result: txs
        });
      } else {
        const txs = await this.hnscan.getTransactions(limit);
        // console.log("txs:", txs);
        res.json(200, { result: txs });
      }
    });

    this.get("/txs/:hash", async (req, res) => {
      const valid = Validator.fromRequest(req);
      const hash = valid.bhash("hash");

      enforce(hash != null, "tx hash required.");

      const tx = await this.hnscan.getTransaction(hash);

      if (!tx) {
        res.json(404);
        return;
      }

      res.json(200, tx);
    });

    //@todo filters for name status
    this.get("/names", async (req, res) => {
      const valid = Validator.fromRequest(req);
      const limit = valid.uint("limit", 25);
      const offset = valid.uint("offset", 0);

      enforce(limit <= 50, "Too many names requested. Max of 50.");
      //@todo not sure if this is true.
      enforce(!this.chain.options.spv, "Cannot get names in SPV mode.");

      // for (let i = start; i > end; i--) {
      // const block = await this.hnscan.getBlock(i);

      // blocks.push(block);
      // }

      const height = this.chain.height;
      const txn = this.chain.db.txn;
      const items = [];

      //@todo would be a lot more efficient to implement something like Lodash memorize here considering this will only change once every 36 blocks.
      const iter = txn.iterator();

      let length = iter.length;
      while (await iter.next()) {
        const { key, value } = iter;
        const ns = NameState.decode(value);
        ns.nameHash = key;

        const info = ns.getJSON(height, this.network);
        //@todo it may actually be more efficient to implement something like Binary Insert here.
        //Ref: https://machinesaredigging.com/2014/04/27/binary-insert-how-to-keep-an-array-sorted-as-you-insert-data-in-it/
        //For now, we are just going to push then sort.
        items.push(info);
      }

      items.sort(function(a, b) {
        if (b.height !== a.height) {
          return b.height - a.height;
        }
        if (a.name === b.name) {
          return 0;
        }
        return a.name > b.name ? 1 : -1;
      });

      const names = items.slice(offset, offset + limit);

      res.json(200, {
        total: items.length,
        offset,
        limit,
        result: names
      });
    });

    this.get("/names/:name", async (req, res) => {
      const valid = Validator.fromRequest(req);
      const name = valid.str("name");

      enforce(name != null, "name required.");

      const nameData = await this.hnscan.getName(name);

      if (!nameData) {
        res.json(404);
        return;
      }

      res.json(200, nameData);
    });

    this.get("/names/:name/history", async (req, res) => {
      const valid = Validator.fromRequest(req);
      const name = valid.str("name");

      enforce(name != null, "name required.");

      //@todo implement offset and limit here.
      const [history, total] = await this.hnscan.getNameHistory(name, 0, 25);

      if (!history) {
        res.json(404);
        return;
      }

      res.json(200, {
        total,
        offset: 0,
        limit: 25,
        result: history
      });
    });

    this.get("/addresses/:hash", async (req, res) => {
      const valid = Validator.fromRequest(req);
      //@todo I believe there is a valid.hash
      const hash = valid.str("hash");

      enforce(hash != null, "address required.");

      //@todo catch this error and return 404.
      let addr = Address.fromString(hash, this.network.type);

      const balance = await this.hnscan.getAddress(addr);

      if (!balance) {
        res.json(404);
        return;
      }

      res.json(200, balance);
    });

    //@todo allow for filtering of peers by services, etc.
    this.get("/peers", async (req, res) => {
      const valid = Validator.fromRequest(req);
      const page = valid.uint("page", 1);
      const limit = valid.uint("limit", 10);
      // const offset = valid.uint("offset", 0);
      const offset = (page - 1) * limit;

      // enforce(limit <= 50, "Too many names requested. Max of 50.");

      const [peers, total] = await this.hnscan.getPeers(offset, limit);

      res.json(200, {
        total,
        result: peers
      });
    });

    //@todo allow for filtering of peers by services, etc.
    this.get("/mapdata", async (req, res) => {
      const peers = await this.hnscan.getPeersLocation();
      const data = [];

      for (let i = 0; i < peers.length; i++) {
        data.push({
          latitude: peers[i].ll[0],
          longitude: peers[i].ll[1],
          title: peers[i].city
        });
      }

      res.json(200, { data: data });
    });

    /*
     *
     * Address HTTP Functions
     *
     */
    this.get("/address/:hash/mempool", async (req, res) => {
      const valid = Validator.fromRequest(req);

      let hash = valid.str("hash");

      //Check if is valid, if not return error - enforce
      let addr = Address.fromString(hash, this.network);

      let txs = this.mempool.getTXByAddress(addr);

      let history = this.mempool.getHistory();

      //@todo
      console.log(history);

      console.log(txs);

      res.json(200, {});
    });

    this.get("/address/:hash/unspent", async (req, res) => {
      const valid = Validator.fromRequest(req);

      let hash = valid.str("hash");
      let limit = valid.u32("limit", 25);
      let offset = valid.u32("offset", 0);

      let end = offset + limit;

      //Check if is valid, if not return error - enforce
      let addr = Address.fromString(hash, this.network);

      let txs = await this.ndb.addressUnspent(addr);

      txs = util.sortTXs(txs);

      let total = txs.length;

      let result = txs.slice(offset, end);

      res.json(200, { total, offset, limit, result });
    });

    // Address Tx History
    this.get("/address/:hash/history", async (req, res) => {
      const valid = Validator.fromRequest(req);

      let hash = valid.str("hash");
      let limit = valid.u32("limit", 10);
      let offset = valid.u32("offset", 0);

      let end = offset + limit;

      let txs;

      let addr = Address.fromString(hash, this.network);

      try {
        txs = await this.ndb.addressHistory(addr);
      } catch (e) {
        res.json(400);
        return;
      }

      //Return out of range if start is beyond array length.
      if (offset > txs.length) {
        res.json(416);
        return;
      }

      txs = util.sortTXs(txs);

      let total = txs.length;

      let result = txs.slice(offset, end);

      res.json(200, { total, offset, limit, result });

      return;
    });

    //@todo this is probably an "epic", but build this search in such a way that we can actually send the data for the next page if needed. So if someone searches just for a TX and that's the only result, then push that data to the React app so that another API request doesn't have to be made when the user is redirected to that page. I think the way we would do that is send it up in an object inside of the JSON called data, and then in the React app, during the search bar redirect we pass Data if it's available. Then in each component, we check to see if data exists *before* making the useResource call.
    this.get("/search", async (req, res) => {
      const valid = Validator.fromRequest(req);

      const query = valid.str("q");
      const txHash = RegExp("^[a-fA-F0-9]{64}$");

      let results = [];

      // Checks if the query is a number.
      if (!isNaN(query)) {
        //Converts search string to int
        let height = +query;

        let tip = this.chain.height;

        //If it's a feasible block height, redirect to block page.
        if (height <= tip && height >= 0) {
          let result = { type: "Block", url: `/block/${height}` };

          results.push(result);
        }
      }
      //@todo switch to hasTX

      if (query.length === 64) {
        if (await this.chain.db.getTX(Buffer.from(query, "hex"))) {
          let result = { type: "Transaction", url: `/tx/${query}` };
          results.push(result);
        }

        let height = await this.chain.db.getHeight(Buffer.from(query, "hex"));

        if (height >= 0) {
          let result = { type: "Block", url: `/block/${height}` };

          results.push(result);
        }
      }

      //Do we want to look up the transaction here, or just test it?
      //@todo actually test the tx here.
      // if (txHash.test(search)) {
      //   let result = { type: "Transaction", url: `/tx/${search}` };
      //   results.push(result);
      // }

      //@todo test for blockhash
      //this.chain.db.getHeight(hash) //Todo await.
      //this.chain.db.getBlock(hash) probably better.

      let address;

      try {
        address = new Address(query);
      } catch (e) {
        //Do nothing.
      }

      if (address) {
        if (address.isValid()) {
          let result = { type: "Address", url: `/address/${query}` };
          results.push(result);
        }
      }

      let name = query.toLowerCase();
      if (rules.verifyString(name)) {
        let result = { type: "Name", url: `/name/${name}` };
        results.push(result);
      }

      return res.json(200, results);
    });

    // Name History
    this.get("/name/:name/history", async (req, res) => {
      const valid = Validator.fromRequest(req);

      let name = valid.str("name");
      let limit = valid.u32("limit", 10);
      let offset = valid.u32("offset", 0);
      let full = valid.bool("full", false);

      let end = offset + limit;

      let txs;

      let nameHash = rules.hashName(name);

      //Do namechecks here, and return accordingly

      try {
        txs = await this.ndb.nameHistory(nameHash);
      } catch (e) {
        res.json(400);
        return;
      }

      //Return out of range if start is beyond array length.
      if (offset > txs.length) {
        res.json(416);
        return;
      }

      txs = util.sortTXs(txs);

      let total = txs.length;

      let result = txs.slice(offset, end);

      res.json(200, { total, offset, limit, result });

      return;
    });

    //Address Balance
    this.get("/address/:hash/balance", async (req, res) => {
      const valid = Validator.fromRequest(req);

      let hash = valid.str("hash");

      let addr = Address.fromString(hash, this.network);

      let balance;

      try {
        balance = await this.ndb.addressBalance(addr);
      } catch (e) {
        res.json(400);
        return;
      }

      res.json(200, balance);

      return;
    });

    this.get("/charts/difficulty", async (req, res) => {
      const valid = Validator.fromRequest(req);
      let startTime = valid.u32("startTime");
      let endTime = valid.u32("endTime");
      let chartData;

      try {
        //@todo move this to hnscan file.
        chartData = await this.hdb.getDifficultySeries(startTime, endTime);
      } catch (e) {
        console.log(e);
        res.json(400);
        return;
      }

      res.json(200, chartData);

      return;
    });

    this.get("/charts/hashrate", async (req, res) => {
      // What is this line?
      const valid = Validator.fromRequest(req);
      let tip = this.chain.tip;
      let numDays = valid.u32("numDays");
      if (numDays > 365) numDays = 365;
      let chartData;

      try {
        for(let i = 0; i < numDays; i++) {
          // 144 ~ 1 day
          let value = await this.getHashRate(144, tip - i * 144);
          // subtract "1 day"
          chartData.push({ date: Date.now() - (i * 24 * 60 * 60 * 1000), value: value })
          if (tip - i * 144 < 0) break;
        }
      } catch (e) {
        console.log(e);
        res.json(400);
        return;
      }
      res.json(200, chartData);

      return;
    });

    this.get("/charts/dailyTransactions", async (req, res) => {
      const valid = Validator.fromRequest(req);
      let startTime = valid.u32("startTime");
      let endTime = valid.u32("endTime");
      let chartData;

      try {
        //@todo move this to hnscan file.
        chartData = await this.hdb.getTransactionSeries(startTime, endTime);
      } catch (e) {
        res.json(400);
        return;
      }

      res.json(200, chartData);

      return;
    });

    this.get("/charts/dailyTotalTransactions", async (req, res) => {
      const valid = Validator.fromRequest(req);
      let startTime = valid.u32("startTime");
      let endTime = valid.u32("endTime");
      let chartData;

      try {
        //@todo move this to hnscan file.
        chartData = await this.hdb.getTotalTransactionSeries(
          startTime,
          endTime
        );
      } catch (e) {
        res.json(400);
        return;
      }

      res.json(200, chartData);

      return;
    });

    this.get("/charts/supply", async (req, res) => {
      const valid = Validator.fromRequest(req);
      let startTime = valid.u32("startTime");
      let endTime = valid.u32("endTime");
      let chartData;

      try {
        //@todo move this to hnscan file.
        chartData = await this.hdb.getSupplySeries(startTime, endTime);
      } catch (e) {
        res.json(400);
        return;
      }

      res.json(200, chartData);

      return;
    });

    this.get("/charts/burned", async (req, res) => {
      const valid = Validator.fromRequest(req);
      let startTime = valid.u32("startTime");
      let endTime = valid.u32("endTime");
      let chartData;

      try {
        //@todo move this to hnscan file.
        chartData = await this.hdb.getBurnedSeries(startTime, endTime);
      } catch (e) {
        res.json(400);
        return;
      }

      res.json(200, chartData);

      return;
    });
  }

  //TODO move these to util or somewhere else.
  txToJSON(tx, entry) {
    let height = -1;
    let time = 0;
    let hash = null;
    let conf = 0;

    if (entry) {
      height = entry.height;
      time = entry.time;
      hash = entry.hash;
      conf = this.client.getTip().height - height + 1;
    }

    const vin = [];

    for (const input of tx.inputs) {
      const json = {
        coinbase: undefined,
        txid: undefined,
        vout: undefined,
        txinwitness: undefined,
        sequence: input.sequence,
        link: input.link
      };

      json.coinbase = tx.isCoinbase();
      json.txid = input.prevout.txid();
      json.vout = input.prevout.index;
      json.txinwitness = input.witness.toJSON();

      vin.push(json);
    }

    const vout = [];

    for (let i = 0; i < tx.outputs.length; i++) {
      const output = tx.outputs[i];
      vout.push({
        value: Amount.coin(output.value, true),
        n: i,
        address: this.addrToJSON(output.address),
        covenant: output.covenant.toJSON()
      });
    }

    return {
      txid: tx.txid(),
      hash: tx.wtxid(),
      size: tx.getSize(),
      vsize: tx.getVirtualSize(),
      version: tx.version,
      locktime: tx.locktime,
      vin: vin,
      vout: vout,
      blockhash: hash ? hash.toString("hex") : null,
      confirmations: conf,
      time: time,
      blocktime: time,
      hex: undefined
    };
  }

  //TODO move these to util or somewhere else.
  addrToJSON(addr) {
    return {
      version: addr.version,
      hash: addr.hash.toString("hex")
    };
  }

  async getHashRate(lookup, height) {
    let tip = this.chain.tip;

    if (height != null) {
      tip = await this.chain.getEntry(height);
    }

    if (!tip) {
      return 0;
    }

    assert(typeof lookup === "number");
    assert(lookup >= 0);

    if (lookup === 0) {
      lookup = (tip.height % this.network.pow.targetWindow) + 1;
    }

    if (lookup > tip.height) {
      lookup = tip.height;
    }

    let min = tip.time;
    let max = min;
    let entry = tip;

    for (let i = 0; i < lookup; i++) {
      entry = await this.chain.getPrevious(entry);

      if (!entry) {
        throw new RPCError(errs.DATABASE_ERROR, "Not found.");
      }

      min = Math.min(entry.time, min);
      max = Math.max(entry.time, max);
    }

    const diff = max - min;

    if (diff === 0) {
      return 0;
    }

    const work = tip.chainwork.sub(entry.chainwork);

    return Number(work.toString()) / diff;
  }
}

class HTTPOptions {
  /**
   * HTTPOptions
   * @alias module:http.HTTPOptions
   * @constructor
   * @param {Object} options
   */

  constructor(options) {
    this.network = Network.primary;
    this.logger = null;
    this.node = null;
    this.apiKey = base58.encode(random.randomBytes(20));
    this.apiHash = sha256.digest(Buffer.from(this.apiKey, "ascii"));
    this.adminToken = random.randomBytes(32);
    this.serviceHash = this.apiHash;
    this.noAuth = false;
    this.cors = false;
    this.walletAuth = false;

    this.prefix = null;
    this.host = "127.0.0.1";
    this.port = 8080;
    this.ssl = false;
    this.keyFile = null;
    this.certFile = null;

    this.fromOptions(options);
  }

  /**
   * Inject properties from object.
   * @private
   * @param {Object} options
   * @returns {HTTPOptions}
   */

  fromOptions(options) {
    assert(options);
    assert(
      options.node && typeof options.node === "object",
      "HTTP Server requires a node."
    );

    this.node = options.node;

    if (options.network != null) this.network = Network.get(options.network);

    if (options.logger != null) {
      assert(typeof options.logger === "object");
      this.logger = options.logger;
    }

    if (options.hdb != null) {
      assert(typeof options.hdb === "object");
      this.hdb = options.hdb;
    }

    if (options.hnscan != null) {
      assert(typeof options.hnscan === "object");
      this.hnscan = options.hnscan;
    }

    if (options.client != null) {
      assert(typeof options.client === "object");
      this.client = options.client;
    }

    if (options.logger != null) {
      assert(typeof options.logger === "object");
      this.logger = options.logger;
    }

    if (options.apiKey != null) {
      assert(typeof options.apiKey === "string", "API key must be a string.");
      assert(options.apiKey.length <= 255, "API key must be under 255 bytes.");
      this.apiKey = options.apiKey;
      this.apiHash = sha256.digest(Buffer.from(this.apiKey, "ascii"));
    }

    if (options.noAuth != null) {
      assert(typeof options.noAuth === "boolean");
      this.noAuth = options.noAuth;
    }

    if (options.cors != null) {
      assert(typeof options.cors === "boolean");
      this.cors = options.cors;
    }

    if (options.prefix != null) {
      assert(typeof options.prefix === "string");
      this.prefix = options.prefix;
      this.keyFile = path.join(this.prefix, "key.pem");
      this.certFile = path.join(this.prefix, "cert.pem");
    }

    if (options.host != null) {
      assert(typeof options.host === "string");
      this.host = options.host;
    }

    if (options.port != null) {
      assert(
        (options.port & 0xffff) === options.port,
        "Port must be a number."
      );
      this.port = options.port;
    }

    if (options.ssl != null) {
      assert(typeof options.ssl === "boolean");
      this.ssl = options.ssl;
    }

    if (options.keyFile != null) {
      assert(typeof options.keyFile === "string");
      this.keyFile = options.keyFile;
    }

    if (options.certFile != null) {
      assert(typeof options.certFile === "string");
      this.certFile = options.certFile;
    }

    // Allow no-auth implicitly
    // if we're listening locally.
    if (!options.apiKey) {
      if (this.host === "127.0.0.1" || this.host === "::1") this.noAuth = true;
    }

    return this;
  }

  /**
   * Instantiate http options from object.
   * @param {Object} options
   * @returns {HTTPOptions}
   */

  static fromOptions(options) {
    return new HTTPOptions().fromOptions(options);
  }
}

/*
 * Helpers
 */

function enforce(value, msg) {
  if (!value) {
    const err = new Error(msg);
    err.statusCode = 400;
    throw err;
  }
}

function toDifficulty(bits) {
  let shift = (bits >>> 24) & 0xff;
  let diff = 0x0000ffff / (bits & 0x00ffffff);

  while (shift < 29) {
    diff *= 256.0;
    shift++;
  }

  while (shift > 29) {
    diff /= 256.0;
    shift--;
  }

  return diff;
}

function sortArr(arr, type) {
  let names = [];

  for (let i = 0; i < arr.length; i++) {
    if (type === "close" && arr[i].state === "CLOSED") {
      names.push(arr[i]);
    } else if (type === "open" && arr[i].state === "OPENING") {
      names.push(arr[i]);
    } else if (type === "bid" && arr[i].state === "BIDDING") {
      names.push(arr[i]);
    } else if (type === "reveal" && arr[i].state === "REVEAL") {
      names.push(arr[i]);
    } else if (type === "all") {
      names.push(arr[i]);
    }
  }

  return names.sort(function(a, b) {
    if (b.height !== a.height) {
      return b.height - a.height;
    }
    if (a.name === b.name) {
      return 0;
    }
    return a.name > b.name ? 1 : -1;
  });
}

/*
 * Expose
 */

module.exports = HTTP;
