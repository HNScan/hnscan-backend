const bio = require("bufio");
const util = require("./util");
const consensus = require("hsd/lib/protocol/consensus");
const assert = require("bsert");

//Create a constructor that sets all of the data, and then we can call that in the indexer.
//
//
//Chart data currently available.
//1. Average Daily difficulty.
//2. Transactions per Day.
//3. Total supply per day.
//4. Total burned
class ChartData extends bio.Struct {
  //move this to from blockData, and then make the contrustor empty
  constructor(entry, block, chainState) {
    super();
    //Time of data.
    this.time = 0;
    //Double
    this.difficulty = 0;
    this.transactions = 0;
    this.supply = 0;
    this.burned = 0;
    this.totalTx = 0;
  }

  fromBlockData(entry, block, chainState) {
    this.time = entry.time || 0;
    //Double
    this.difficulty = util.toDifficulty(entry.bits) || 0;
    this.transactions = block.txs.length || 0;
    this.supply = chainState.value || 0;
    this.burned = chainState.burned || 0;
    this.totalTx = chainState.tx || 0;
    return this;
  }

  write(bw) {
    bw.writeDouble(this.difficulty);
    bw.writeU32(this.transactions);
    bw.writeU64(this.supply);
    bw.writeU64(this.burned);
    bw.writeU64(this.totalTx);
    return bw;
  }

  read(br) {
    this.time = 0;
    this.difficulty = br.readDouble();
    this.transactions = br.readU32();
    this.supply = br.readU64();
    this.burned = br.readU64();
    this.totalTx = br.readU64();
    return this;
  }

  fromObject(data) {
    this.time = data.time || 0;
    this.difficulty = data.difficulty || 0;
    this.transactions = data.transactions || 0;
    this.supply = data.supply || 0;
    this.burned = data.burned || 0;
    this.totalTx = data.totalTx || 0;
    return this;
  }

  //creates average chart data from an array of chart data elements.
  static fromArray(data) {
    let sums = data.reduce(function(a, b) {
      return {
        difficulty: a.difficulty + b.difficulty,
        transactions: a.transactions + b.transactions,
        supply: Math.max(a.supply, b.supply),
        burned: Math.max(a.burned, b.burned),
        totalTx: Math.max(a.totalTx, b.totalTx)
      };
    });

    //We want average difficulty.
    sums.difficulty /= data.length;
    //make the time the UTC midnight of that day.
    sums.time = Math.floor(data[0].time / (3600 * 24));

    //@todo return new this().fromObject(sums);
    // return sums;
    return new this().fromObject(sums);
  }

  static fromBlockData(entry, block, state) {
    return new this().fromBlockData(entry, block, state);
  }
}

/**
 * Chain State
 */

class ChainState extends bio.Struct {
  /**
   * Create chain state.
   * @alias module:blockchain.ChainState
   * @constructor
   */

  constructor() {
    super();
    this.tip = consensus.ZERO_HASH;
    this.tx = 0;
    this.coin = 0;
    this.value = 0;
    this.burned = 0;
    this.committed = false;
  }

  inject(state) {
    this.tip = state.tip;
    this.tx = state.tx;
    this.coin = state.coin;
    this.value = state.value;
    this.burned = state.burned;
    return this;
  }

  connect(block) {
    this.tx += block.txs.length;
  }

  disconnect(block) {
    this.tx -= block.txs.length;
  }

  add(coin) {
    this.coin += 1;
    this.value += coin.value;
  }

  spend(coin) {
    this.coin -= 1;
    this.value -= coin.value;
  }

  burn(coin) {
    this.coin += 1;
    this.burned += coin.value;
  }

  unburn(coin) {
    this.coin -= 1;
    this.burned -= coin.value;
  }

  commit(hash) {
    assert(Buffer.isBuffer(hash));
    this.tip = hash;
    this.committed = true;
    return this.encode();
  }

  getSize() {
    return 64;
  }

  write(bw) {
    bw.writeHash(this.tip);
    bw.writeU64(this.tx);
    bw.writeU64(this.coin);
    bw.writeU64(this.value);
    bw.writeU64(this.burned);
    return bw;
  }

  read(br) {
    this.tip = br.readHash();
    this.tx = br.readU64();
    this.coin = br.readU64();
    this.value = br.readU64();
    this.burned = br.readU64();
    return this;
  }
}

module.exports.ChartData = ChartData;
module.exports.ChainState = ChainState;
