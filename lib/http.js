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
        const block = await this.chain.getBlock(i);

        const view = await this.chain.getBlockView(block);

        if (!view) {
          res.json(404);
          return;
        }

        const depth = this.chain.height - i + 1;
        const entry = await this.chain.getEntryByHeight(i);

        if (!entry) {
          res.json(404);
          return;
        }

        const next = await this.chain.getNextHash(entry.hash);

        blocks.push(
          block.getJSON(this.network.toString(), view, i, depth, next, entry)
        );
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

      const block = await this.chain.getBlock(height);

      if (!block) {
        res.json(404);
        return;
      }

      const view = await this.chain.getBlockView(block);

      if (!view) {
        res.json(404);
        return;
      }

      const depth = this.chain.height - height + 1;
      const entry = await this.chain.getEntryByHeight(height);

      if (!entry) {
        res.json(404);
        return;
      }

      const next = await this.chain.getNextHash(entry.hash);

      block.getJSON(this.network.toString(), view, height, depth, next, entry);

      res.json(
        200,
        block.getJSON(this.network.toString(), view, height, depth, next, entry)
      );
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

    if (options.ndb != null) {
      assert(typeof options.ndb === "object");
      this.ndb = options.ndb;
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

/*
 * Expose
 */

module.exports = HTTP;