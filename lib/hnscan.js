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
const rules = require("hsd/lib/covenants/rules");

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
    this.hdb = this.options.hdb;
    this.node = this.options.node;
  }

  async getTransactions(limit = 25) {
    let txs = [];

    for (let i = this.chain.height; i > -1; i--) {
      const block = await this.chain.getBlock(i);
      const entry = await this.chain.getEntryByHeight(i);

      for (let tx of block.txs) {
        let json = await this.txToJSON(tx, entry);
        const meta = await this.node.getMeta(tx.hash());
        const view = await this.node.getMetaView(meta);
        // console.log(meta.getJSON(this.network.type, view, this.chain.height));

        let json2 = meta.getJSON(this.network.type, view, this.chain.height);
        json.fee = json2.fee;
        txs.push(json);

        if (txs.length === limit) {
          return txs;
        }
      }
    }
  }

  //@todo make this standard for all list APIs, return [data, total]
  async getTransactionsByHeight(height, offset = 0, limit = 25) {
    const block = await this.chain.getBlock(height);
    const entry = await this.chain.getEntryByHeight(height);
    let txs = [];

    let list = block.txs.slice(offset, offset + limit);

    for (const tx of list) {
      const json = await this.txToJSON(tx, entry);
      txs.push(json);
    }

    return [txs, block.txs.length];
  }

  //Expects a Address object NOT a hash or string
  async getTransactionsByAddress(addr, offset = 0, limit = 25) {
    //@todo this may be pretty slow as we increase the # of transactions for users. See what we acn do about this.
    //That said, the transaction numbers we are seeing on the testnet are probably pretty unrealistic.
    const raw = await this.hdb.addressHistory(addr);

    const list = raw.slice(offset, offset + limit);

    let txs = [];

    for (let i = 0; i < list.length; i++) {
      //I'd really like this to format the transactions as well... @todo
      let tx = await this.getTransaction(Buffer.from(list[i].tx_hash, "hex"));
      txs.push(tx);
    }

    return [txs, raw.length];
  }

  async getAddress(addr) {
    let address = await this.hdb.addressBalance(addr);

    address.hash = addr.toString(this.network.type);

    return address;
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
    let miner = block.txs[0].outputs[0].address.toString(this.network.type);

    let txs = [];

    //@todo kill this if it's entirely covered in the above API call.
    if (details) {
      for (const tx of block.txs) {
        const json = await this.txToJSON(tx, entry);
        txs.push(json);
        continue;
      }
    }

    return {
      hash: entry.hash.toString("hex"),
      confirmations: this.chain.height - entry.height + 1,
      strippedSize: block.getBaseSize(),
      size: block.getSize(),
      weight: block.getWeight(),
      height: entry.height,
      version: entry.version,
      merkleRoot: entry.merkleRoot.toString("hex"),
      witnessRoot: entry.witnessRoot.toString("hex"),
      treeRoot: entry.treeRoot.toString("hex"),
      filterRoot: entry.filterRoot.toString("hex"),
      reservedRoot: entry.reservedRoot.toString("hex"),
      coinbase: details ? block.txs[0].inputs[0].witness.toJSON() : undefined,
      tx: details ? txs : undefined,
      txs: block.txs.length,
      fees,
      miner,
      averageFee: fees / block.txs.length,
      time: entry.time,
      medianTime: mtp,
      bits: entry.bits,
      difficulty: toDifficulty(entry.bits),
      chainwork: entry.chainwork.toString("hex", 64),
      prevBlock: !entry.prevBlock.equals(consensus.ZERO_HASH)
        ? entry.prevBlock.toString("hex")
        : null,
      nextHash: next ? next.toString("hex") : null,
      nonce: entry.nonce.toString("hex")
    };
  }

  async getTransaction(hash) {
    const meta = await this.node.getMeta(hash);

    if (!meta) {
      return;
    }

    const view = await this.node.getMetaView(meta);

    return meta.getJSON(this.network.type, view, this.chain.height);
  }

  async getName(name) {
    const height = this.chain.height;
    const nameHash = rules.hashName(name);
    const reserved = rules.isReserved(nameHash, height + 1, this.network);
    const [start, week] = rules.getRollout(nameHash, this.network);
    const ns = await this.chain.db.getNameState(nameHash);

    let info = null;

    if (ns) {
      if (!ns.isExpired(height, this.network))
        info = ns.getJSON(height, this.network.type);
    }

    //@todo pull this into it's own function.
    let nextState = "";

    switch (info.state) {
      case "OPENING":
        nextState = "BIDDING";
        break;
      case "BIDDING":
        nextState = "REVEAL";
        break;
      case "REVEAL":
        nextState = "CLOSED";
        break;
      case "CLOSED":
        nextState = "RENEWAL";
    }

    let res = null;
    try {
      res = Resource.decode(ns.data);
      // return res.toJSON();
    } catch (e) {}

    //Offset, limit
    // let history = await this.nameHistory(nameHash, 0, 25);

    //@todo show owner if it's not empty hash.
    //@todo have renewals link to a page on the name -> /name/sean/renewals
    //@todo use expired, and have that show names that were closed but then expired.
    return {
      name,
      hash: nameHash.toString("hex"),
      height: info.height,
      highest: info.highest,
      value: info.value,
      renewal: info.renewal,
      renewals: info.renewals,
      weak: info.weak,
      transfer: info.transfer,
      revoked: info.revoked,
      release: start,
      reserved,
      state: info.state,
      nextState,
      records: res,
      blocksUntil: Object.values(info.stats)[2]
    };
  }

  async txToJSON(tx, entry) {
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

    const inputs = [];

    for (const input of tx.inputs) {
      const json = {
        coinbase: undefined,
        value: undefined,
        address: undefined
      };

      json.coinbase = tx.isCoinbase();

      if (!input.coin) {
        json.value = consensus.getReward(height, this.network.halvingInterval);
      } else {
        json.value = input.coin.value;
        json.address = input.coin.address;
      }

      inputs.push(json);
    }

    //@todo break this into it's own function, along with the input one.
    const outputs = [];

    for (let i = 0; i < tx.outputs.length; i++) {
      const output = tx.outputs[i];
      output.covenant = output.covenant.getJSON();

      const json = {
        action: output.covenant.action,
        address: output.address.getHash().toString("hex"),
        value: undefined,
        name: undefined,
        nameHash: undefined
      };

      switch (json.action) {
        case "NONE":
          json.value = output.value;
          break;

        case "OPEN":
          json.name = Buffer.from(output.covenant.items[2], "hex").toString();
          break;

        case "BID":
          //@todo Need to decode start height
          // newOutput.startHeight = items[1];
          json.name = Buffer.from(output.covenant.items[2], "hex").toString();
          json.value = output.value;
          break;

        case "REVEAL":
          //@todo Need to decode start height
          // newOutput.startHeight = items[1];
          json.nonce = output.covenant.items[2];
          json.value = output.value;
          break;

        case "REDEEM":
          break;

        // case "REGISTER":
      }

      if (json.action != "NONE") {
        json.nameHash = output.covenant.items[0];
        if (!json.name) {
          const ns = await this.chain.db.getNameState(
            Buffer.from(json.nameHash, "hex")
          );
          if (ns) {
            json.name = ns.name.toString("binary");
          }
        }
      }
      // outputs.push({
      //   value: Amount.coin(output.value, true),
      //   n: i,
      //   address: this.addrToJSON(output.address),
      //   covenant: output.covenant.toJSON()
      // });
      outputs.push(json);
    }

    //@todo rename these to inputs/outputs....
    return {
      txid: tx.txid(),
      hash: tx.wtxid(),
      size: tx.getSize(),
      vsize: tx.getVirtualSize(),
      version: tx.version,
      locktime: tx.locktime,
      inputs,
      outputs,
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

  async getPeers(offset = 0, limit = 10) {
    let peers = [];

    for (let peer = this.node.pool.peers.head(); peer; peer = peer.next) {
      const offset = this.network.time.known.get(peer.hostname()) || 0;
      const hashes = [];

      for (const hash in peer.blockMap.keys())
        hashes.push(hash.toString("hex"));

      peer.getName();

      peers.push({
        id: peer.id,
        addr: peer.fullname(),
        addrlocal: !peer.local.isNull() ? peer.local.fullname() : undefined,
        name: peer.name || undefined,
        services: hex32(peer.services),
        relaytxes: !peer.noRelay,
        lastsend: (peer.lastSend / 1000) | 0,
        lastrecv: (peer.lastRecv / 1000) | 0,
        bytessent: peer.socket.bytesWritten,
        bytesrecv: peer.socket.bytesRead,
        conntime: peer.time !== 0 ? ((Date.now() - peer.time) / 1000) | 0 : 0,
        timeoffset: offset,
        pingtime:
          peer.lastPong !== -1 ? (peer.lastPong - peer.lastPing) / 1000 : -1,
        minping: peer.minPing !== -1 ? peer.minPing / 1000 : -1,
        version: peer.version,
        subver: peer.agent,
        inbound: !peer.outbound,
        startingheight: peer.height,
        besthash: peer.bestHash.toString("hex"),
        bestheight: peer.bestHeight,
        banscore: peer.banScore,
        inflight: hashes,
        whitelisted: false
      });
    }

    //@todo optimize both of these by doing them before pushing all the data above.
    let total = peers.length;

    peers = peers.slice(offset, offset + limit);

    return [peers, total];
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

  //@todo Not all bids and reveals are returning a value. help.
  async getNameHistory(name, offset = 0, limit = 25) {
    const nameHash = rules.hashName(name);
    let entireList = await this.hdb.nameHistory(nameHash);
    //Sort in descending order.
    entireList.sort((a, b) => (a.height < b.height ? 1 : -1));

    let total = entireList.length;

    let list = entireList.slice(offset, offset + limit);

    let history = [];
    for (let i = 0; i < list.length; i++) {
      let tx = await this.getTransaction(Buffer.from(list[i].tx_hash, "hex"));
      let j = 0;
      for (let o of tx.outputs) {
        let newtx = {};
        // let cov = new Covenant(o.covenant.type, o.covenant.items);
        let cov = new Covenant(o.covenant.type, []);
        cov = cov.fromString(o.covenant.items);

        if (cov.isName()) {
          if (cov.get(0).toString("hex") === nameHash.toString("hex")) {
            if (cov.isOpen()) {
              newtx.action = "Opened";
            }

            if (cov.isBid()) {
              newtx.action = "Bid";
              newtx.value = o.value;
            }

            if (cov.isReveal()) {
              //See if we can connect Reveals to Bids using the nonce.
              newtx.action = "Reveal";
              newtx.value = o.value;
            }

            //XXX Add owner information to this.
            //See if this is called on a transfer as well.
            if (cov.isRegister()) {
              //Link to the data on a new page.
              newtx.action = "Register";
            }

            if (cov.isRedeem()) {
              //Redeem non winning bids?
              //Possibly also connect these to reveals and bids.
              newtx.action = "Redeem";
              newtx.value = o.value;
            }

            if (cov.isUpdate()) {
              //Link data on new page
              newtx.action = "Update";
            }

            if (cov.isRenew()) {
              newtx.action = "Renew";
            }

            newtx.time = tx.mtime;
            newtx.height = list[i].height;
            newtx.txid = list[i].tx_hash;
            newtx.index = j;
            history.push(newtx);
          }
        }
        j++;
      }
    }
    return [history, total];
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

    if (options.hdb != null) {
      assert(typeof options.hdb === "object");
      this.hdb = options.hdb;
    }

    if (options.node != null) {
      assert(typeof options.node === "object");
      this.node = options.node;
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
