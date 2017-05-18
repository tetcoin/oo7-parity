import {Bond, TimeBond, TransformBond as oo7TransformBond, ReactivePromise} from 'oo7';
import BigNumber from 'bignumber.js';
import {abiPolyfill} from './abis.js';

export function setupBonds(_api = parity.api) {
	let api = _api;
	var bonds = {};

	if (!api.util.abiSignature) {
		console.info("Polyfilling api.util.abiSignature");
		api.util.abiSignature = function (name, inputs) {
			return api.util.sha3(`${name}(${inputs.join()})`);
		};
	}

	if (!api.abi) {
		api.abi = abiPolyfill();
	}

	class TransformBond extends oo7TransformBond {
		constructor (f, a = [], d = [], outResolveDepth = 0, resolveDepth = 1, latched = true, mayBeNull = true) {
			super(f, a, d, outResolveDepth, resolveDepth, latched, mayBeNull, api);
		}
		map (f, outResolveDepth = 0, resolveDepth = 1) {
	        return new TransformBond(f, [this], [], outResolveDepth, resolveDepth);
	    }
		sub (name, outResolveDepth = 0, resolveDepth = 1) {
			return new TransformBond((r, n) => r[n], [this, name], [], outResolveDepth, resolveDepth);
		}
		static all(list) {
			return new TransformBond((...args) => args, list);
		}
	}

	// TODO: Use more generic means to check on number, ideally push notification.
	class SubscriptionBond extends Bond {
		constructor(rpc) {
			super();
			this.rpc = rpc;
		}
		initialise () {
			api.subscribe(this.rpc, (_, n) => this.trigger(n))
				.then(id => this.subscription = id);
		}
		finalise () {
			api.unsubscribe(this.subscription);
		}
		map (f) {
	        return new TransformBond(f, [this]);
	    }
		sub (name) {
			return new TransformBond((r, n) => r[n], [this, name]);
		}
		static all(list) {
			return new TransformBond((...args) => args, list);
		}
	}

	class Signature extends ReactivePromise {
		constructor(message, from) {
			super([message, from], [], ([message, from]) => {
				api.parity.postSign(from, api.util.asciiToHex(message))
					.then(signerRequestId => {
						this.trigger({requested: signerRequestId});
				    	return api.pollMethod('parity_checkRequest', signerRequestId);
				    })
				    .then(signature => {
						this.trigger({
							signed: splitSignature(signature)
						});
					})
					.catch(error => {
						console.error(error);
						this.trigger({failed: error});
					});
			}, false);
			this.then(_ => null);
		}
		isDone(s) {
			return !!s.failed || !!s.signed;
		}
	}

	function transactionPromise(tx, progress, f) {
		progress({initialising: null});
		Promise.all([api.eth.accounts(), api.eth.gasPrice()])
			.then(([a, p]) => {
				progress({estimating: null});
				tx.from = tx.from || a[0];
				tx.gasPrice = tx.gasPrice || p;
				return api.eth.estimateGas(tx);
			})
			.then(g => {
				progress({estimated: g});
				tx.gas = tx.gas || g;
				return api.parity.postTransaction(tx);
			})
			.then(signerRequestId => {
				progress({requested: signerRequestId});
				return api.pollMethod('parity_checkRequest', signerRequestId);
			})
			.then(transactionHash => {
				progress({signed: transactionHash});
				return api.pollMethod('eth_getTransactionReceipt', transactionHash, (receipt) => receipt && receipt.blockNumber && !receipt.blockNumber.eq(0));
			})
			.then(receipt => {
				progress(f({confirmed: receipt}));
				return receipt;
			})
			.catch(error => {
				progress({failed: error});
			});
	}

	class Transaction extends ReactivePromise {
		constructor(tx) {
			super([tx], [], ([tx]) => {
				let progress = this.trigger.bind(this);
				transactionPromise(tx, progress, _ => _);
			}, false);
			this.then(_ => null);
		}
		isDone(s) {
			return !!(s.failed || s.confirmed);
		}
	}

	function overlay(base, top) {
		Object.keys(top).forEach(k => {
			base[k] = top[k];
		});
		return base;
	}

	function memoized(f) {
		var memo;
		return function() {
			if (memo === undefined)
				memo = f();
			return memo;
		};
	}

	function call(addr, method, args, options) {
		let data = api.util.abiEncode(method.name, method.inputs.map(f => f.type), args);
		let decode = d => api.util.abiDecode(method.outputs.map(f => f.type), d);
		return api.eth.call(overlay({to: addr, data: data}, options)).then(decode);
	};

	function post(addr, method, args, options) {
		let toOptions = (addr, method, options, ...args) => {
			return overlay({to: addr, data: api.util.abiEncode(method.name, method.inputs.map(f => f.type), args)}, options);
		};
		return new Transaction(toOptions.bond(addr, method, options, ...args));
	};

	bonds.Subscription = SubscriptionBond;
	bonds.Transform = TransformBond;
    bonds.time = new TimeBond;
	// TODO: rename `height`
	bonds.blockNumber = new TransformBond(() => api.eth.blockNumber().then(_=>+_), [], [bonds.time]);
//	bonds.blockNumber = new TransformBond(_=>+_, [new SubscriptionBond('eth_blockNumber')]);
//	bonds.accounts = new SubscriptionBond('eth_accounts').subscriptable();
//	bonds.accountsInfo = new SubscriptionBond('parity_accountsInfo').subscriptable();
//	bonds.defaultAccount = new SubscriptionBond('parity_defaultAccount').subscriptable();
//	bonds.allAccountsInfo = new SubscriptionBond('parity_allAccountsInfo');
//	bonds.requestsToConfirm = new SubscriptionBond('signer_requestsToConfirm');

	Function.__proto__.bond = function(...args) { return new TransformBond(this, args); };
	Function.__proto__.unlatchedBond = function(...args) { return new TransformBond(this, args, [], false, undefined); };
    Function.__proto__.timeBond = function(...args) { return new TransformBond(this, args, [bonds.time]); };
    Function.__proto__.blockBond = function(...args) { return new TransformBond(this, args, [bonds.blockNumber]); };

	let presub = function (f) {
		return new Proxy(f, {
			get (receiver, name) {
				if (typeof(name) === 'string' || typeof(name) === 'number') {
					return typeof(receiver[name]) !== 'undefined' ? receiver[name] : receiver(name);
				} else if (typeof(name) === 'symbol' && Bond.knowSymbol(name)) {
					return receiver(Bond.fromSymbol(name));
				} else {
					throw `Weird value type to be subscripted by: ${typeof(name)}: ${JSON.stringify(name)}`;
				}
			}
		});
	};

	function isNumber(n) { return typeof(n) === 'number' || (typeof(n) === 'string' && n.match(/^[0-9]+$/)); }

	let onAccountsChanged = bonds.time; // TODO: more accurate notification
	let onHardwareAccountsChanged = bonds.time; // TODO: more accurate notification
	let onHeadChanged = bonds.blockNumber;	// TODO: more accurate notification
//	let onReorg = undefined;	// TODO make more accurate.
	let onSyncingChanged = bonds.time;
	let onAuthoringDetailsChanged = bonds.time;
	let onPeerNetChanged = bonds.time; // TODO: more accurate notification
	let onPendingChanged = bonds.time; // TODO: more accurate notification
	let onUnsignedChanged = bonds.time; // TODO: more accurate notification
	let onAutoUpdateChanged = bonds.blockNumber;

	// eth_
	bonds.height = bonds.blockNumber;
	bonds.blockByNumber = (x => new TransformBond(api.eth.getBlockByNumber, [x], []).subscriptable());// TODO: chain reorg that includes number x
	bonds.blockByHash = (x => new TransformBond(api.eth.getBlockByHash, [x]).subscriptable());
	bonds.findBlock = (hashOrNumberBond => new TransformBond(hashOrNumber => isNumber(hashOrNumber)
		? api.eth.getBlockByNumber(hashOrNumber)
		: api.eth.getBlockByHash(hashOrNumber),
		[hashOrNumberBond], [/*onReorg*/]).subscriptable());// TODO: chain reorg that includes number x, if x is a number
	bonds.blocks = presub(bonds.findBlock);
	bonds.block = bonds.blockByNumber(bonds.blockNumber);	// TODO: DEPRECATE AND REMOVE
	bonds.head = new TransformBond(() => api.eth.getBlockByNumber('latest'), [], [onHeadChanged]).subscriptable();// TODO: chain reorgs
	bonds.author = new TransformBond(api.eth.coinbase, [], [onAccountsChanged]);
	bonds.accounts = new TransformBond(a => a.map(api.util.toChecksumAddress), [new TransformBond(api.eth.accounts, [], [onAccountsChanged])]).subscriptable();
	bonds.defaultAccount = bonds.accounts[0];	// TODO: make this use its subscription
	bonds.me = bonds.accounts[0];
	bonds.post = tx => new Transaction(tx);
	bonds.sign = (message, from = parity.bonds.me) => new Signature(message, from);

	bonds.balance = (x => new TransformBond(api.eth.getBalance, [x], [onHeadChanged]));
	bonds.code = (x => new TransformBond(api.eth.getCode, [x], [onHeadChanged]));
	bonds.nonce = (x => new TransformBond(() => api.eth.getTransactionCount().then(_ => +_), [x], [onHeadChanged]));
	bonds.storageAt = ((x, y) => new TransformBond(api.eth.getStorageAt, [x, y], [onHeadChanged]));

	bonds.syncing = new TransformBond(api.eth.syncing, [], [onSyncingChanged]);
	bonds.hashrate = new TransformBond(api.eth.hashrate, [], [onAuthoringDetailsChanged]);
	bonds.mining = new TransformBond(api.eth.mining, [], [onAuthoringDetailsChanged]);
	bonds.protocolVersion = new TransformBond(api.eth.protocolVersion, [], []);
	bonds.gasPrice = new TransformBond(api.eth.gasPrice, [], [onHeadChanged]);
	bonds.estimateGas = (x => new TransformBond(api.eth.estimateGas, [x], [onHeadChanged, onPendingChanged]));

	bonds.blockTransactionCount = (hashOrNumberBond => new TransformBond(
		hashOrNumber => isNumber(hashOrNumber)
			? api.eth.getBlockTransactionCountByNumber(hashOrNumber).then(_ => +_)
			: api.eth.getBlockTransactionCountByHash(hashOrNumber).then(_ => +_),
		[hashOrNumberBond], isNumber(hashOrNumber) ? [/*onReorg*/] : []));
	bonds.uncleCount = (hashOrNumberBond => new TransformBond(
		hashOrNumber => isNumber(hashOrNumber)
			? api.eth.getUncleCountByBlockNumber(hashOrNumber).then(_ => +_)
			: api.eth.getUncleCountByBlockHash(hashOrNumber).then(_ => +_),
		[hashOrNumberBond], isNumber(hashOrNumber) ? [/*onReorg*/] : []).subscriptable());
	bonds.uncle = ((hashOrNumberBond, indexBond) => new TransformBond(
		(hashOrNumber, index) => isNumber(hashOrNumber)
			? api.eth.getUncleByBlockNumber(hashOrNumber, index)
			: api.eth.getUncleByBlockHash(hashOrNumber, index),
		[hashOrNumberBond, indexBond], isNumber(hashOrNumber) ? [/*onReorg*/] : []).subscriptable());
	bonds.transaction = ((hashOrNumberBond, indexOrNullBond) => new TransformBond(
		(hashOrNumber, indexOrNull) =>
			indexOrNull === undefined || indexOrNull === null
				? api.eth.getTransactionByHash(hashOrNumber)
				: isNumber(hashOrNumber)
					? api.eth.getTransactionByBlockNumberAndIndex(hashOrNumber, indexOrNull)
					: api.eth.getTransactionByBlockHashAndIndex(hashOrNumber, indexOrNull),
			[hashOrNumberBond, indexOrNullBond], isNumber(hashOrNumber) ? [/*onReorg*/] : []).subscriptable());
	bonds.receipt = (hashBond => new TransformBond(api.eth.getTransactionReceipt, [hashBond], []).subscriptable());

	// web3_
	bonds.clientVersion = new TransformBond(api.web3.clientVersion, [], []);

	// net_
	bonds.peerCount = new TransformBond(() => api.net.peerCount().then(_ => +_), [], [onPeerNetChanged]);
	bonds.listening = new TransformBond(api.net.listening, [], [onPeerNetChanged]);
	bonds.chainId = new TransformBond(api.net.version, [], []);

	// parity_
	bonds.hashContent = u => new TransformBond(api.parity.hashContent, [u], [], false);
	bonds.gasPriceHistogram = new TransformBond(api.parity.gasPriceHistogram, [], [onHeadChanged]).subscriptable();
	bonds.accountsInfo = new TransformBond(api.parity.accountsInfo, [], [onAccountsChanged]).subscriptable(2);
	bonds.hardwareAccountsInfo = new TransformBond(api.parity.hardwareAccountsInfo, [], [onHardwareAccountsChanged]).subscriptable(2);
	bonds.mode = new TransformBond(api.parity.mode, [], [bonds.blockNumber]);

	// ...authoring
	bonds.defaultExtraData = new TransformBond(api.parity.defaultExtraData, [], [onAuthoringDetailsChanged]);
	bonds.extraData = new TransformBond(api.parity.extraData, [], [onAuthoringDetailsChanged]);
	bonds.gasCeilTarget = new TransformBond(api.parity.gasCeilTarget, [], [onAuthoringDetailsChanged]);
	bonds.gasFloorTarget = new TransformBond(api.parity.gasFloorTarget, [], [onAuthoringDetailsChanged]);
	bonds.minGasPrice = new TransformBond(api.parity.minGasPrice, [], [onAuthoringDetailsChanged]);
	bonds.transactionsLimit = new TransformBond(api.parity.transactionsLimit, [], [onAuthoringDetailsChanged]);

	// ...chain info
	bonds.chainName = new TransformBond(api.parity.netChain, [], []);
	bonds.chainStatus = new TransformBond(api.parity.chainStatus, [], [onSyncingChanged]).subscriptable();

	// ...networking
	bonds.peers = new TransformBond(api.parity.netPeers, [], [onPeerNetChanged]).subscriptable(2);
	bonds.enode = new TransformBond(api.parity.enode, [], []);
	bonds.nodePort = new TransformBond(() => api.parity.netPort().then(_=>+_), [], []);
	bonds.nodeName = new TransformBond(api.parity.nodeName, [], []);
	bonds.signerPort = new TransformBond(() => api.parity.signerPort().then(_=>+_), [], []);
	bonds.dappsPort = new TransformBond(() => api.parity.dappsPort().then(_=>+_), [], []);
	bonds.dappsInterface = new TransformBond(api.parity.dappsInterface, [], []);

	// ...transaction queue
	bonds.nextNonce = new TransformBond(() => api.parity.nextNonce().then(_=>+_), [], [onPendingChanged]);
	bonds.pending = new TransformBond(api.parity.pendingTransactions, [], [onPendingChanged]);
	bonds.local = new TransformBond(api.parity.localTransactions, [], [onPendingChanged]).subscriptable(3);
	bonds.future = new TransformBond(api.parity.futureTransactions, [], [onPendingChanged]).subscriptable(2);
	bonds.pendingStats = new TransformBond(() => api.parity.pendingTransactionsStats(), [], [onPendingChanged]).subscriptable(2);
	bonds.unsignedCount = new TransformBond(() => api.parity.parity_unsignedTransactionsCount().then(_=>+_), [], [onUnsignedChanged]);

	// ...auto-update
	bonds.releasesInfo = new TransformBond(api.parity.releasesInfo, [], [onAutoUpdateChanged]).subscriptable();
	bonds.versionInfo = new TransformBond(api.parity.versionInfo, [], [onAutoUpdateChanged]).subscriptable();
	bonds.consensusCapability = new TransformBond(api.parity.consensusCapability, [], [onAutoUpdateChanged]);
	bonds.upgradeReady = new TransformBond(api.parity.upgradeReady, [], [onAutoUpdateChanged]).subscriptable();

	class DeployContract extends ReactivePromise {
		constructor(initBond, abiBond, optionsBond) {
			super([initBond, abiBond, optionsBond, bonds.registry], [], ([init, abi, options, registry]) => {
				options.data = init;
				delete options.to;
				let progress = this.trigger.bind(this);
				transactionPromise(options, progress, status => {
					if (status.confirmed) {
						status.deployed = bonds.makeContract(status.confirmed.contractAddress, abi, options.extras || []);
					}
					return status;
				});
				// TODO: consider allowing registry of the contract here.
			}, false);
			this.then(_ => null);
		}
		isDone(s) {
			return !!(s.failed || s.confirmed);
		}
	}

	bonds.deployContract = function(init, abi, options = {}) {
		return new DeployContract(init, abi, options);
	}

	bonds.makeContract = function(address, abi, extras = []) {
		var r = { address: address };
		let unwrapIfOne = a => a.length == 1 ? a[0] : a;
		abi.forEach(i => {
			if (i.type == 'function' && i.constant) {
				let f = function (...args) {
					var options = args.length === i.inputs.length + 1 ? args.unshift() : {};
					if (args.length != i.inputs.length)
						throw `Invalid number of arguments to ${i.name}. Expected ${i.inputs.length}, got ${args.length}.`;
					let f = (addr, ...fargs) => call(addr, i, fargs, options)
						.then(rets => rets.map((r, o) => cleanup(r, i.outputs[o].type, api)))
						.then(unwrapIfOne);
					return new TransformBond(f, [address, ...args], [bonds.blockNumber]).subscriptable();	// TODO: should be subscription on contract events
				};
				r[i.name] = (i.inputs.length === 0) ? memoized(f) : (i.inputs.length === 1) ? presub(f) : f;
			}
		});
		extras.forEach(i => {
			let f = function (...args) {
				let expectedInputs = (i.numInputs || i.args.length);
				var options = args.length === expectedInputs + 1 ? args.unshift() : {};
				if (args.length != expectedInputs)
					throw `Invalid number of arguments to ${i.name}. Expected ${expectedInputs}, got ${args.length}.`;
				let c = abi.find(j => j.name == i.method);
				let f = (addr, ...fargs) => {
					let args = i.args.map((v, index) => v === null ? fargs[index] : typeof(v) === 'function' ? v(fargs[index]) : v);
					return call(addr, c, args, options).then(unwrapIfOne);
				};
				return new TransformBond(f, [address, ...args], [bonds.blockNumber]).subscriptable();	// TODO: should be subscription on contract events
			};
			r[i.name] = (i.args.length === 1) ? presub(f) : f;
		});
		abi.forEach(i => {
			if (i.type == 'function' && !i.constant) {
				r[i.name] = function (...args) {
					var options = args.length === i.inputs.length + 1 ? args.pop() : {};
					if (args.length !== i.inputs.length)
						throw `Invalid number of arguments to ${i.name}. Expected ${i.inputs.length}, got ${args.length}.`;
					return post(address, i, args, options).subscriptable();
				};
			}
		});
		var eventLookup = {};
		abi.filter(i => i.type == 'event').forEach(i => {
			eventLookup[api.util.abiSignature(i.name, i.inputs.map(f => f.type))] = i.name;
		});

		function prepareIndexEncode(v, t, top = true) {
			if (v instanceof Array) {
				if (top) {
					return v.map(x => prepareIndexEncode(x, t, false));
				} else {
					throw 'Invalid type';
				}
			}
			var val;
			if (t == 'string' || t == 'bytes') {
				val = api.util.sha3(v);
			} else {
				val = api.util.abiEncode(null, [t], [v]);
			}
			if (val.length != 66) {
				throw 'Invalid length';
			}
			return val;
		}

		abi.forEach(i => {
			if (i.type == 'event') {
				r[i.name] = function (indexed = {}, params = {}) {
					return new TransformBond((addr, indexed) => {
						var topics = [api.util.abiSignature(i.name, i.inputs.map(f => f.type))];
						i.inputs.filter(f => f.indexed).forEach(f => {
							try {
								topics.push(indexed[f.name] ? prepareIndexEncode(indexed[f.name], f.type) : null);
							}
							catch (e) {
								throw `Couldn't encode indexed parameter ${f.name} of type ${f.type} with value ${indexed[f.name]}`;
							}
						});
						return api.eth.getLogs({
							address: addr,
							fromBlock: params.fromBlock || 0,
							toBlock: params.toBlock || 'pending',
							limit: params.limit || 10,
							topics: topics
						}).then(logs => logs.map(l => {
							l.blockNumber = +l.blockNumber;
							l.transactionIndex = +l.transactionIndex;
							l.logIndex = +l.logIndex;
							l.transactionLogIndex = +l.transactionLogIndex;
							var e = {};
							let unins = i.inputs.filter(f => !f.indexed);
							api.util.abiDecode(unins.map(f => f.type), l.data).forEach((v, j) => {
								let f = unins[j];
								if (v instanceof Array && !f.type.endsWith(']')) {
									v = api.util.bytesToHex(v);
								}
								if (f.type.substr(0, 4) == 'uint' && +f.type.substr(4) <= 48) {
									v = +v;
								}
								e[f.name] = v;
							});
							i.inputs.filter(f => f.indexed).forEach((f, j) => {
								if (f.type == 'string' || f.type == 'bytes') {
									l.args[f.name] = l.topics[1 + j];
								} else {
									var v = api.util.abiDecode([f.type], l.topics[1 + j])[0];
									if (v instanceof Array) {
										v = api.util.bytesToHex(v);
									}
									if (f.type.substr(0, 4) == 'uint' && +f.type.substr(4) <= 48) {
										v = +v;
									}
									e[f.name] = v;
								}
							});
							e.event = eventLookup[l.topics[0]];
							e.log = l;
							return e;
						}));
					}, [address, indexed], [bonds.blockNumber]).subscriptable();
				};
			}
		});
		return r;
	};

	bonds.registry = bonds.makeContract(new TransformBond(api.parity.registryAddress, [], [bonds.time]), api.abi.registry, api.abi.registryExtras);	// TODO should be subscription.
	bonds.githubhint = bonds.makeContract(bonds.registry.lookupAddress('githubhint', 'A'), api.abi.githubhint);
	bonds.operations = bonds.makeContract(bonds.registry.lookupAddress('operations', 'A'), api.abi.operations);
	bonds.badgereg = bonds.makeContract(bonds.registry.lookupAddress('badgereg', 'A'), api.abi.badgereg);
	bonds.tokenreg = bonds.makeContract(bonds.registry.lookupAddress('tokenreg', 'A'), api.abi.tokenreg);

	bonds.badges = new TransformBond(n => {
		var ret = [];
		for (var i = 0; i < +n; ++i) {
			let id = i;
			ret.push(Bond.all([
					bonds.badgereg.badge(id),
					bonds.badgereg.meta(id, 'IMG'),
					bonds.badgereg.meta(id, 'CAPTION')
				]).map(([[addr, name, owner], img, caption]) => ({
					id,
					name,
					img,
					caption,
					badge: bonds.makeContract(addr, api.abi.badge)
				}))
			);
		}
		return ret;
	}, [bonds.badgereg.badgeCount()], [], 1);

	bonds.badgesOf = address => new TransformBond(
		(addr, bads) => bads.map(b => ({
			certified: b.badge.certified(addr),
			addr: addr,
			id: b.id,
			img: b.img,
			caption: b.caption,
			name: b.name
		})),
		[address, bonds.badges], [], 2
	).map(all => all.filter(_=>_.certified));

	bonds.namesOf = address => new TransformBond((reg, addr, accs) => ({
		owned: accs[addr] ? accs[addr].name : null,
		registry: reg || null
	}), [bonds.registry.reverse(address), address, bonds.accountsInfo]);

	bonds.registry.names = Bond.mapAll([bonds.registry.ReverseConfirmed({}, {limit: 100}), bonds.accountsInfo],
		(reg, info) => {
			let r = {};
			Object.keys(info).forEach(k => r[k] = info[k].name);
			reg.forEach(a => r[a.reverse] = bonds.registry.reverse(a.reverse));
			return r;
		}, 1)

	return bonds;
}

////
// Parity Utilities

// TODO: move to parity.js, repackage or repot.

export function capitalizeFirstLetter(s) {
    return s.charAt(0).toUpperCase() + s.slice(1);
}

export function singleton(f) {
    var instance = null;
    return function() {
        if (instance === null)
            instance = f();
        return instance;
    }
}

export const denominations = [ "wei", "Kwei", "Mwei", "Gwei", "szabo", "finney", "ether", "grand", "Mether", "Gether", "Tether", "Pether", "Eether", "Zether", "Yether", "Nether", "Dether", "Vether", "Uether" ];

export function denominationMultiplier(s) {
    let i = denominations.indexOf(s);
    if (i < 0)
        throw "Invalid denomination";
    return (new BigNumber(1000)).pow(i);
}

export function interpretQuantity(s) {
    try {
        let m = s.toLowerCase().match('([0-9,.]+) *([a-zA-Z]+)?');
        let d = denominationMultiplier(m[2] || 'ether');
        let n = +m[1].replace(',', '');
        while (n !== Math.round(n)) {
            n *= 10;
            d = d.div(10);
        }
        return new BigNumber(n).mul(d);
    }
    catch (e) {
        return null;
    }
}

export function splitValue(a) {
	var i = 0;
	var a = new BigNumber('' + a);
	if (a.gte(new BigNumber("10000000000000000")) && a.lt(new BigNumber("100000000000000000000000")) || a.eq(0))
		i = 6;
	else
		for (var aa = a; aa.gte(1000) && i < denominations.length - 1; aa = aa.div(1000))
			i++;

	for (var j = 0; j < i; ++j)
		a = a.div(1000);

	return {base: a, denom: i};
}

export function formatBalance(n) {
	let a = splitValue(n);
	let b = Math.floor(a.base * 1000) / 1000;
	return `${b} ${denominations[a.denom]}`;
}

export function formatBlockNumber(n) {
    return '#' + ('' + n).replace(/(\d)(?=(\d{3})+$)/g, "$1,");
}

export function isNullData(a) {
	return !a || typeof(a) !== 'string' || a.match(/^(0x)?0+$/) !== null;
}

export function splitSignature (sig) {
	if ((sig.substr(2, 2) === '1b' || sig.substr(2, 2) === '1c') && (sig.substr(66, 2) !== '1b' && sig.substr(66, 2) !== '1c')) {
		// vrs
		return [sig.substr(0, 4), `0x${sig.substr(4, 64)}`, `0x${sig.substr(68, 64)}`];
	} else {
		// rsv
		return [`0x${sig.substr(130, 2)}`, `0x${sig.substr(2, 64)}`, `0x${sig.substr(66, 64)}`];
	}
};

export function removeSigningPrefix (message) {
	if (!message.startsWith('\x19Ethereum Signed Message:\n')) {
		throw 'Invalid message - doesn\'t contain security prefix';
	}
	for (var i = 1; i < 6; ++i) {
		if (message.length == 26 + i + +message.substr(26, i)) {
			return message.substr(26 + i);
		}
	}
	throw 'Invalid message - invalid security prefix';
};

export function cleanup (value, type = 'bytes32', api = parity.api) {
	// TODO: make work with arbitrary depth arrays
	if (value instanceof Array && type.match(/bytes[0-9]+/)) {
		// figure out if it's an ASCII string hiding in there:
		var ascii = '';
		for (var i = 0, ended = false; i < value.length && ascii !== null; ++i) {
			if (value[i] === 0) {
				ended = true;
			} else {
				ascii += String.fromCharCode(value[i]);
			}
			if ((ended && value[i] !== 0) || (!ended && (value[i] < 32 || value[i] >= 128))) {
				ascii = null;
			}
		}
		value = ascii === null ? '0x' + value.map(n => ('0' + n.toString(16)).slice(-2)).join('') : ascii;
	}
	if (type.substr(0, 4) == 'uint' && +type.substr(4) <= 48) {
		value = +value;
	}
	return value;
}

export { abiPolyfill };
