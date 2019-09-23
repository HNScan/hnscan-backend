/*!
 * hnscan.js - hnscan api
 * Copyright (c) 2017-2018, Christopher Jeffrey (MIT License).
 * Copyright (c) 2018-2019, Handshake Alliance Developers (MIT License).
 * https://github.com/handshakealliance/hnscan-backend
 */

"use strict";

const EventEmitter = require("events");
const path = require("path");
const { Network, Address, Covenant, Script, Coin } = require("hsd");
const consensus = require("hsd/lib/protocol/consensus");
const Amount = require("hsd/lib/ui/amount");
const Logger = require("blgr");
const assert = require("bsert");
const bdb = require("bdb");
const layout = require("./layout");
const { Lock } = require("bmutex");
const bio = require("bufio");
const blake2b = require("bcrypto/lib/blake2b");

/**
 * Hnscan
 * @alias module:hnscan.hnscanDB
 * @extends EventEmitter
 */

class Hnscan extends EventEmitter {
  /**
   * Create a hnscan .
   * @constructor
   * @param {Object} options
   */

  constructor(options) {
    super();
    this.options = new HnscanOptions(options);

    this.network = this.options.network;
    this.logger = this.options.logger.context("hnscan");
    this.client = this.options.client;
    this.chain = this.options.chain;
  }

  async getBlock(height, details = true) {
    const block = await this.chain.getBlock(height);

    const view = await this.chain.getBlockView(block);

    if (!view) {
      return;
    }

    const depth = this.chain.height - height + 1;
    const entry = await this.chain.getEntryByHeight(height);

    if (!entry) {
      return;
    }

    const mtp = await this.chain.getMedianTime(entry);
    const next = await this.chain.getNextHash(entry.hash);

    let cbOutput = Amount.coin(block.txs[0].outputs[0].value, true);

    //Need to get reward here.
    let reward = Amount.fromBase(
      consensus.getReward(height, this.network.halvingInterval)
    );

    let fees = cbOutput - reward.toCoins();
    let miner = block.txs[0].outputs[0].address.getHash().toString("hex");

    let txs = [];

    if (details) {
      for (const tx of block.txs) {
        const json = this.txToJSON(tx, entry);
        txs.push(json);
        continue;
      }
    }

    return {
      hash: entry.hash.toString("hex"),
      confirmations: this.chain.height - entry.height + 1,
      strippedsize: block.getBaseSize(),
      size: block.getSize(),
      weight: block.getWeight(),
      height: entry.height,
      version: entry.version,
      versionHex: hex32(entry.version),
      merkleRoot: entry.merkleRoot.toString("hex"),
      witnessRoot: entry.witnessRoot.toString("hex"),
      treeRoot: entry.treeRoot.toString("hex"),
      filterRoot: entry.filterRoot.toString("hex"),
      reservedRoot: entry.reservedRoot.toString("hex"),
      coinbase: !details ? block.txs[0].inputs[0].witness.toJSON() : undefined,
      tx: !details ? txs : undefined,
      txs: block.txs.length,
      fees,
      miner,
      averageFee: fees / block.txs.length,
      time: entry.time,
      mediantime: mtp,
      bits: entry.bits,
      difficulty: toDifficulty(entry.bits),
      chainwork: entry.chainwork.toString("hex", 64),
      prevBlock: !entry.prevBlock.equals(consensus.ZERO_HASH)
        ? entry.prevBlock.toString("hex")
        : null,
      nextHash: next ? next.toString("hex") : null
    };
  }

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

    //@todo rename these to inputs/outputs....
    return {
      txid: tx.txid(),
      hash: tx.wtxid(),
      size: tx.getSize(),
      vsize: tx.getVirtualSize(),
      version: tx.version,
      locktime: tx.locktime,
      inputs: vin,
      outputs: vout,
      blockhash: hash ? hash.toString("hex") : null,
      confirmations: conf,
      time: time,
      blocktime: time,
      hex: undefined
    };
  }

  addrToJSON(addr) {
    return {
      version: addr.version,
      hash: addr.hash.toString("hex")
    };
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
}

class HnscanOptions {
  /**
   * Create hnscan options.
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
   * @returns {HnscanOptions}
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

    if (options.chain != null) {
      assert(typeof options.chain === "object");
      this.chain = options.chain;
    }

    assert(this.client);

    return this;
  }

  /**
   * Instantiate chain options from object.
   * @param {Object} options
   * @returns {HnscanOptions}
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

function hex32(num) {
  assert(num >= 0);

  num = num.toString(16);

  assert(num.length <= 8);

  while (num.length < 8) num = "0" + num;

  return num;
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

module.exports = Hnscan;
