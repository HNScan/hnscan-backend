/*!
 * hnscandb.js - hnscan database
 * Copyright (c) 2017-2018, Christopher Jeffrey (MIT License).
 * Copyright (c) 2018-2019, Handshake Alliance Developers (MIT License).
 * https://github.com/handshakealliance/hnscan-backend
 */

"use strict";

const EventEmitter = require("events");
const path = require("path");
const { Network, Address, Covenant, Script, Coin } = require("hsd");
const Logger = require("blgr");
const assert = require("bsert");
const bdb = require("bdb");
const layout = require("./layout");
const { Lock } = require("bmutex");
const bio = require("bufio");
const blake2b = require("bcrypto/lib/blake2b");
const { ChartData, ChainState } = require("./types");
const rules = require("hsd/lib/covenants/rules");
const { types } = rules;
const Amount = require("hsd/lib/ui/amount");

/**
 * HnscanDB
 * @alias module:hnscan.hnscanDB
 * @extends EventEmitter
 */

class HnscanDB extends EventEmitter {
  /**
   * Create a hnscan db.
   * @constructor
   * @param {Object} options
   */

  constructor(options) {
    super();
    this.options = new HnscanDBOptions(options);

    this.network = this.options.network;
    this.logger = this.options.logger.context("hnscan");
    this.db = bdb.create(this.options);
    this.client = this.options.client;
    this.state = new ChainState();
    this.pending = new ChainState();

    this.chartDataCurrentDate = 0;
    this.chartDataCurrent = [];
  }

  /**
   * Open the hnscandb, wait for the database to load.
   * @returns {Promise}
   */

  async open() {
    await this.db.open();

    await this.db.verify(layout.V.encode(), "hnscan", 0);

    const state = await this.getState();

    if (state) {
      this.state = state;
    }
  }

  /**
   * Return header from the database.
   * @returns {Promise}
   */

  async getHeaders(height) {
    return await this.db.get(layout.h.encode(height));
  }

  async getHashByHeight(height) {
    let header = await this.db.get(layout.h.encode(height));

    return blake2b.digest(header);
  }

  /**
   * Verify network.
   * @returns {Promise}
   */

  async verifyNetwork() {
    const raw = await this.db.get(layout.O.encode());

    if (!raw) {
      const b = this.db.batch();
      b.put(layout.O.encode(), fromU32(this.network.magic));
      return b.write();
    }

    const magic = raw.readUInt32LE(0, true);

    if (magic !== this.network.magic)
      throw new Error("Network mismatch for HnscanDB.");

    return undefined;
  }

  /**
   * Close the hnscandb, wait for the database to close.
   * @returns {Promise}
   */

  async close() {
    return this.db.close();
  }

  batch() {
    return this.db.batch();
  }

  async saveEntry(entry, block, view) {
    this.pending = this.state.clone();
    const hash = block.hash();
    this.pending.connect(block);

    // Update chain state value.
    for (let i = 0; i < block.txs.length; i++) {
      const tx = block.txs[i];

      if (i > 0) {
        for (const { prevout } of tx.inputs) {
          //@todo returning Burned and supply needs to be divided by 6 0s.
          this.pending.spend(view.getOutput(prevout));
        }
      }

      for (let i = 0; i < tx.outputs.length; i++) {
        const output = tx.outputs[i];

        if (output.isUnspendable()) continue;

        // Registers are burned.
        if (output.covenant.isRegister()) {
          this.pending.burn(output);
          continue;
        }

        if (
          output.covenant.type >= types.UPDATE &&
          output.covenant.type <= types.REVOKE
        ) {
          continue;
        }

        this.pending.add(output);
      }
    }

    this.pending.commit(hash);
    this.state = this.pending;
    this.pending = null;
  }

  async saveState() {
    this.db.put(layout.s.encode(), this.state.encode());
  }

  //Need to edit this function - add more error checking
  async setHeight(height) {
    this.height = height;

    //Insert into DB.
    await this.db.put(layout.H.encode(), fromU32(height));

    return;
  }

  async getHeight() {
    let height = await this.db.get(layout.H.encode());

    if (height == null) {
      height = 0;
    } else {
      height = toU32(height);
    }

    return height;
  }

  //For each block difficulty within the day,
  //Would be great to only set 1 of these a day.
  async setChartData(data) {
    let date = Math.floor(data.time / (3600 * 24));

    if (this.chartDataCurrentDate === 0) {
      //initialization
      this.chartDataCurrentDate = date;
      this.chartDataCurrent.push(data);
    } else if (date > this.chartDataCurrentDate) {
      let avg = ChartData.fromArray(this.chartDataCurrent);

      await this.db.put(layout.d.encode(date * 3600 * 24), avg.encode());

      this.chartDataCurrent = [];
      this.chartDataCurrent.push(data);
      this.chartDataCurrentDate = date;
      return;
    }

    this.chartDataCurrent.push(data);
  }

  async getDifficultySeries(startTime, endTime) {
    const iter = this.db.iterator({
      gte: layout.d.min(startTime),
      lte: layout.d.max(endTime),
      values: true
    });

    let tickData = [];

    await iter.each(async (key, rawValue) => {
      const [time] = layout.d.decode(key);
      const chartData = ChartData.decode(rawValue);

      let tick = {
        date: time * 1000,
        value: chartData.difficulty
      };

      tickData.push(tick);
    });

    return tickData;
  }

  async getTransactionSeries(startTime, endTime) {
    const iter = this.db.iterator({
      gte: layout.d.min(startTime),
      lte: layout.d.max(endTime),
      values: true
    });

    let tickData = [];

    await iter.each(async (key, rawValue) => {
      const [time] = layout.d.decode(key);
      const chartData = ChartData.decode(rawValue);

      let tick = {
        date: time * 1000,
        value: chartData.transactions
      };

      tickData.push(tick);
    });

    return tickData;
  }

  //@todo revamp all these and put them into 1 call w/ dynamic data fetching.
  async getTotalTransactionSeries(startTime, endTime) {
    const iter = this.db.iterator({
      gte: layout.d.min(startTime),
      lte: layout.d.max(endTime),
      values: true
    });

    let tickData = [];

    await iter.each(async (key, rawValue) => {
      const [time] = layout.d.decode(key);
      const chartData = ChartData.decode(rawValue);

      let tick = {
        date: time * 1000,
        value: chartData.totalTx
      };

      tickData.push(tick);
    });

    return tickData;
  }

  async getSupplySeries(startTime, endTime) {
    const iter = this.db.iterator({
      gte: layout.d.min(startTime),
      lte: layout.d.max(endTime),
      values: true
    });

    let tickData = [];

    await iter.each(async (key, rawValue) => {
      const [time] = layout.d.decode(key);
      const chartData = ChartData.decode(rawValue);

      let tick = {
        date: time * 1000,
        value: Amount.coin(chartData.supply)
      };

      tickData.push(tick);
    });

    return tickData;
  }

  async getBurnedSeries(startTime, endTime) {
    const iter = this.db.iterator({
      gte: layout.d.min(startTime),
      lte: layout.d.max(endTime),
      values: true
    });

    let tickData = [];

    await iter.each(async (key, rawValue) => {
      const [time] = layout.d.decode(key);
      const chartData = ChartData.decode(rawValue);

      let tick = {
        date: time * 1000,
        value: Amount.coin(chartData.burned)
      };

      tickData.push(tick);
    });

    return tickData;
  }

  /**
   * Return the funding outputs for an address, confirmed and unconfirmed.
   * @param addr - {Address}
   * @returns {Promise} -> {[confirmed: Number, unconfirmed: Number]}
   */
  async addressFunding(addr) {
    try {
      let confirmed = await this._addressFunding(addr);
      let unconfirmed = await this._addressFundingUnconfirmed(addr);

      return [confirmed, unconfirmed];
    } catch (e) {
      console.log(e);
      return;
    }
  }

  async _addressFunding(addr) {
    let hash = addr.getHash();
    let funding = [];

    const iter = this.db.iterator({
      gte: layout.o.min(hash),
      lte: layout.o.max(hash),
      values: true
    });

    await iter.each(async (key, raw) => {
      const [userHash, txid] = layout.o.decode(key);

      let tx = {
        userHash,
        tx_hash: txid.toString("hex"),
        height: toU32(raw)
      };

      let newtx = await this.client.getTX(txid);

      let outputIndex;
      let value;

      for (let i = 0; i < newtx.outputs.length; i++) {
        if (userHash.equals(newtx.outputs[i].address.getHash())) {
          outputIndex = i;
          value = newtx.outputs[i].value;
          break;
        }
      }

      let output = {
        tx_hash: txid.toString("hex"),
        height: toU32(raw),
        output_index: outputIndex,
        value
      };

      funding.push(output);
    });

    return funding;
  }

  //TODO
  async _addressFundingUnconfirmed(hash) {
    return [];
  }

  async addressSpent(hash, funding) {
    let confirmed = await this._addressSpent(hash, funding);
    let unconfirmed = await this._addressSpentUnconfirmed(hash, funding);

    return [confirmed, unconfirmed];
  }

  async _addressSpent(hash, funding) {
    let spents = [];
    for (let o of funding) {
      let txPrefix = Buffer.from(o.tx_hash, "hex").slice(0, 8);

      const txHashX = await this.db.get(
        layout.i.encode(txPrefix, o.output_index)
      );

      if (txHashX) {
        // let newtx = await this.client.getTX(txHashX);
        let height = await this.db.get(layout.t.encode(txHashX));
        height = toU32(height);

        // let found = false;

        // for (let i = 0; i < newtx.inputs.length; i++) {
        //   let outpoint = newtx.inputs[i].prevout;
        //   if (
        //     outpoint.hash.toString("hex") === o.tx_hash &&
        //     outpoint.index === o.output_index
        //   ) {
        //     found = true;

        //     break;
        //   }
        // }

        // if (found) {
        let spent = {
          tx_hash: txHashX.toString("hex"),
          height: height,
          funding_output: [o.tx_hash, o.output_index],
          value: o.value
        };
        spents.push(spent);
        // }
      }
    }

    return spents;
  }

  async _addressSpentUnconfirmed(hash, funding) {
    return [];
  }

  //Calculate Balance for an address
  //TODO might actually be faster to have 1 function for both unconfirmed.
  //Instead of in each subfunction.
  async addressBalance(addr) {
    let [fConfirmed, fUnconfirmed] = await this.addressFunding(addr);
    let [sConfirmed, sUnconfirmed] = await this.addressSpent(addr, fConfirmed);

    let totalFunded = 0;
    for (let f of fConfirmed) {
      totalFunded += f.value;
    }

    let totalSpent = 0;
    for (let s of sConfirmed) {
      totalSpent += s.value;
    }

    let balance = {
      confirmed: totalFunded - totalSpent,
      unconfirmed: totalFunded - totalSpent,
      received: totalFunded,
      spent: totalSpent
    };

    return balance;
  }

  async addressHistory(addr) {
    let [fConfirmed, fUnconfirmed] = await this.addressFunding(addr);
    let [sConfirmed, sUnconfirmed] = await this.addressSpent(addr, fConfirmed);

    let txs = [];

    for (let f of fConfirmed) {
      let newtx = {
        tx_hash: f.tx_hash,
        height: f.height
      };
      txs.push(newtx);
    }

    for (let s of sConfirmed) {
      let newtx = {
        tx_hash: s.tx_hash,
        height: s.height
      };
      txs.push(newtx);
    }

    //TODO implement mempool txs.
    //Probably implement this through the client.

    return txs;
  }

  async addressUnspent(addr) {
    let [fConfirmed, fUnconfirmed] = await this.addressFunding(addr);
    let [sConfirmed, sUnconfirmed] = await this.addressSpent(addr, fConfirmed);

    let txs = [];

    for (let f of fConfirmed) {
      let newtx = {
        tx_hash: f.tx_hash,
        height: f.height,
        tx_pos: f.output_index,
        value: f.value
      };
      txs.push(newtx);
    }

    for (let s of sConfirmed) {
      txs = txs.filter(tx => tx.tx_hash !== s.funding_output[0]);
    }

    return txs;
  }

  async nameHistory(nameHash) {
    let auctionList = [];

    const iter = this.db.iterator({
      gte: layout.n.min(nameHash),
      lte: layout.n.max(nameHash),
      values: true
    });

    await iter.each(async (key, raw) => {
      const [, txid] = layout.n.decode(key);

      let tx = {
        tx_hash: txid.toString("hex"),
        height: toU32(raw)
      };

      auctionList.push(tx);
    });

    return auctionList;
  }

  async getState() {
    const data = await this.db.get(layout.s.encode());

    if (!data) return null;

    return ChainState.decode(data);
  }
}

class HnscanDBOptions {
  /**
   * Create hnscandb options.
   * @constructor
   * @param {Object} options
   */

  constructor(options) {
    this.network = Network.primary;
    this.logger = Logger.global;
    this.client = null;
    this.prefix = null;
    this.location = null;
    this.memory = true;
    this.maxFiles = 64;
    this.cacheSize = 16 << 20;
    this.compression = true;

    if (options) this._fromOptions(options);
  }

  /**
   * Inject properties from object.
   * @private
   * @param {Object} options
   * @returns {HnscanDBOptions}
   */

  _fromOptions(options) {
    if (options.network != null) this.network = Network.get(options.network);

    if (options.logger != null) {
      assert(typeof options.logger === "object");
      this.logger = options.logger;
    }

    if (options.client != null) {
      assert(typeof options.client === "object");
      this.client = options.client;
    }

    assert(this.client);

    if (options.prefix != null) {
      assert(typeof options.prefix === "string");
      this.prefix = options.prefix;
      this.location = path.join(this.prefix, "hnscan");
    }

    if (options.location != null) {
      assert(typeof options.location === "string");
      this.location = options.location;
    }

    if (options.memory != null) {
      assert(typeof options.memory === "boolean");
      this.memory = options.memory;
    }

    if (options.maxFiles != null) {
      assert(options.maxFiles >>> 0 === options.maxFiles);
      this.maxFiles = options.maxFiles;
    }

    if (options.cacheSize != null) {
      assert(Number.isSafeInteger(options.cacheSize) && options.cacheSize >= 0);
      this.cacheSize = options.cacheSize;
    }

    if (options.compression != null) {
      assert(typeof options.compression === "boolean");
      this.compression = options.compression;
    }

    return this;
  }

  /**
   * Instantiate chain options from object.
   * @param {Object} options
   * @returns {HnscanDBOptions}
   */

  static fromOptions(options) {
    return new this()._fromOptions(options);
  }
}

/*
 * Helpers
 */

function fromU32(num) {
  const data = Buffer.allocUnsafe(4);
  data.writeUInt32LE(num, 0, true);
  return data;
}

function toU32(buf) {
  const num = buf.readUInt32LE(0, true);
  return num;
}

module.exports = HnscanDB;
