import { DatabaseSync } from "node:sqlite";
// \0rolldown/runtime.js
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __commonJSMin = (cb, mod) => () => (mod || (cb((mod = { exports: {} }).exports, mod, mod.exports), cb = null), mod.exports);
var __copyProps = (to, from, except, desc) => {
	if (from && typeof from === "object" || typeof from === "function") for (var keys = __getOwnPropNames(from), i = 0, n = keys.length, key; i < n; i++) {
		key = keys[i];
		if (!__hasOwnProp.call(to, key) && key !== except) __defProp(to, key, {
			get: ((k) => from[k]).bind(null, key),
			enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable
		});
	}
	return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(isNodeMode || !mod || !mod.__esModule || !__hasOwnProp.call(mod, "default") ? __defProp(target, "default", {
	value: mod,
	enumerable: true
}) : target, mod));
// ../plugin-api/src/catalog.ts
/** Sorts by `name`, the order every catalog list but columns is returned in. */
function byName(items) {
	return [...items].sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
}
// ../plugin-api/src/errors.ts
/** What a plugin throws when the host should react to the kind of failure, not just show it. */
var PluginError = class extends Error {
	code;
	name = "PluginError";
	position;
	constructor(code, message, options) {
		super(message, options);
		this.code = code;
		this.position = options?.position;
	}
};
/**
* `Introspector.definition` asked for a relation the database does not have, usually one dropped
* or renamed since the catalog was read (decision 029). Coded `definitionNotFound`, so the host
* recognises it with `isPluginError` across plugin bundles.
*/
var DefinitionNotFoundError = class extends PluginError {
	path;
	relation;
	constructor(path, relation, options) {
		super("definitionNotFound", `There is no relation ${relation} in ${path.join(".")}; synchronize the data source to see what it holds now.`, options);
		this.path = path;
		this.relation = relation;
	}
};
// ../../node_modules/.bun/zod@4.6.7/node_modules/zod/v4/core/util.js
function getEnumValues(entries) {
	const numericValues = Object.values(entries).filter((v) => typeof v === "number");
	return Object.entries(entries).filter(([k, _]) => numericValues.indexOf(+k) === -1).map(([_, v]) => v);
}
function joinValues(array, separator = "|") {
	return array.map((val) => stringifyPrimitive(val)).join(separator);
}
function jsonStringifyReplacer(_, value) {
	if (typeof value === "bigint") return value.toString();
	return value;
}
var Cached = class {
	constructor(getter) {
		this._getter = getter;
		this._value = void 0;
	}
	get value() {
		const getter = this._getter;
		if (getter !== void 0) {
			this._value = getter();
			this._getter = void 0;
		}
		return this._value;
	}
};
function cached(getter) {
	return new Cached(getter);
}
function nullish(input) {
	return input === null || input === void 0;
}
function cleanRegex(source) {
	const start = source.startsWith("^") ? 1 : 0;
	const end = source.endsWith("$") ? source.length - 1 : source.length;
	return source.slice(start, end);
}
function floatSafeRemainder(val, step) {
	const ratio = val / step;
	const roundedRatio = Math.round(ratio);
	const tolerance = 4 * Number.EPSILON * Math.max(Math.abs(ratio), 1);
	if (Math.abs(ratio - roundedRatio) < tolerance) return 0;
	return ratio - roundedRatio;
}
function assignProp(target, prop, value) {
	Object.defineProperty(target, prop, {
		value,
		writable: true,
		enumerable: true,
		configurable: true
	});
}
/**
* Whichever object a def's `shape` currently answers from: the one the caller passed until the first read, the frozen copy after it.
*
* Its keys and descriptors read without invoking anything, which is what lets a discriminated union check its discriminator, and the cycle walk read a shape, without resolving a getter that references the schema being constructed. A def that answers `shape` from an accessor of its own has none.
*/
function rawShape(def) {
	const desc = Object.getOwnPropertyDescriptor(def, "shape");
	return desc?.get ? desc.get.raw : desc?.value;
}
function sourceShape(schema) {
	return rawShape(schema._zod.def) ?? schema._zod.def.shape;
}
function deferProp(target, key, getter) {
	Object.defineProperty(target, key, {
		get() {
			const value = getter();
			assignProp(this, key, value);
			return value;
		},
		enumerable: true,
		configurable: true
	});
}
function putProp(target, key, value) {
	if (key in target) assignProp(target, key, value);
	else target[key] = value;
}
/**
* Copies `keys` of `source`'s shape onto `target`, each value passed through `wrap`.
*
* A key the source has resolved is copied through now, so the derived shape states it outright and nothing has to resolve it to learn what it holds. A key the source still defers stays deferred, and reads back through the source's own `shape`, so it resolves once and both shapes get that one schema.
*/
function mirrorShape(target, source, keys, wrap) {
	const raw = sourceShape(source);
	for (const key of keys) {
		const desc = Object.getOwnPropertyDescriptor(raw, key);
		if (!desc.enumerable) continue;
		if (desc.get) deferProp(target, key, () => {
			const value = source._zod.def.shape[key];
			return wrap ? wrap(value, key) : value;
		});
		else putProp(target, key, wrap ? wrap(desc.value, key) : desc.value);
	}
}
function mirrorProps(target, source) {
	for (const key of Reflect.ownKeys(source)) {
		const desc = Object.getOwnPropertyDescriptor(source, key);
		if (!desc.enumerable) continue;
		if (desc.get) deferProp(target, key, () => source[key]);
		else putProp(target, key, desc.value);
	}
}
function mergeDefs(...defs) {
	const mergedDescriptors = {};
	for (const def of defs) {
		const descriptors = Object.getOwnPropertyDescriptors(def);
		Object.assign(mergedDescriptors, descriptors);
	}
	return Object.defineProperties({}, mergedDescriptors);
}
function esc(str) {
	return JSON.stringify(str);
}
function slugify(input) {
	return input.toLowerCase().trim().replace(/[^\w\s-]/g, "").replace(/[\s_-]+/g, "-").replace(/^-+|-+$/g, "");
}
var captureStackTrace = "captureStackTrace" in Error ? Error.captureStackTrace : (..._args) => {};
function isObject(data) {
	return typeof data === "object" && data !== null && !Array.isArray(data);
}
var allowsEval = /* @__PURE__*/ cached(() => {
	if (globalConfig.jitless) return false;
	if (typeof navigator !== "undefined" && navigator?.userAgent?.includes("Cloudflare")) return false;
	try {
		new Function("");
		return true;
	} catch (_) {
		return false;
	}
});
function isPlainObject(o) {
	if (isObject(o) === false) return false;
	const ctor = o.constructor;
	if (ctor === void 0) return true;
	if (typeof ctor !== "function") return true;
	const prot = ctor.prototype;
	if (isObject(prot) === false) return false;
	if (Object.prototype.hasOwnProperty.call(prot, "isPrototypeOf") === false) return false;
	return true;
}
function shallowClone(o) {
	if (isPlainObject(o)) return { ...o };
	if (Array.isArray(o)) return [...o];
	if (o instanceof Map) return new Map(o);
	if (o instanceof Set) return new Set(o);
	return o;
}
var propertyKeyTypes = /* @__PURE__*/ new Set([
	"string",
	"number",
	"symbol"
]);
function escapeRegex(str) {
	return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function clone(inst, def, params) {
	const cl = new inst._zod.constr(def ?? inst._zod.def);
	if (!def || params?.parent) cl._zod.parent = inst;
	return cl;
}
function normalizeParams(_params) {
	const params = _params;
	if (!params) return {};
	if (typeof params === "string") return { error: () => params };
	if (params?.message !== void 0) {
		if (params?.error !== void 0) throw new Error("Cannot specify both `message` and `error` params");
		params.error = params.message;
	}
	delete params.message;
	if (typeof params.error === "string") return {
		...params,
		error: () => params.error
	};
	return params;
}
function stringifyPrimitive(value) {
	if (typeof value === "bigint") return value.toString() + "n";
	if (typeof value === "string") return `"${value}"`;
	return `${value}`;
}
function optionalKeys(shape) {
	return Object.keys(shape).filter((k) => {
		return shape[k]._zod.optin !== void 0 && shape[k]._zod.optout === "optional";
	});
}
var NUMBER_FORMAT_RANGES = /*@__PURE__*/ (() => ({
	safeint: [Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER],
	int32: [-2147483648, 2147483647],
	uint32: [0, 4294967295],
	float32: [-34028234663852886e22, 34028234663852886e22],
	float64: [-Number.MAX_VALUE, Number.MAX_VALUE]
}))();
var BIGINT_FORMAT_RANGES = {
	int64: [/* @__PURE__*/ BigInt("-9223372036854775808"), /* @__PURE__*/ BigInt("9223372036854775807")],
	uint64: [/* @__PURE__*/ BigInt(0), /* @__PURE__*/ BigInt("18446744073709551615")]
};
function pick(schema, mask) {
	const currDef = schema._zod.def;
	const checks = currDef.checks;
	if (checks && checks.length > 0) throw new Error(".pick() cannot be used on object schemas containing refinements");
	const newShape = {};
	mirrorShape(newShape, schema, maskedKeys(schema, mask));
	return clone(schema, mergeDefs(currDef, {
		shape: newShape,
		checks: []
	}));
}
function maskedKeys(schema, mask) {
	const raw = sourceShape(schema);
	const keys = [];
	for (const key of Reflect.ownKeys(mask)) {
		if (!Object.getOwnPropertyDescriptor(raw, key)?.enumerable) throw new Error(`Unrecognized key: "${String(key)}"`);
		if (mask[key]) keys.push(key);
	}
	return keys;
}
function omit(schema, mask) {
	const currDef = schema._zod.def;
	const checks = currDef.checks;
	if (checks && checks.length > 0) throw new Error(".omit() cannot be used on object schemas containing refinements");
	const omitted = new Set(maskedKeys(schema, mask));
	const newShape = {};
	mirrorShape(newShape, schema, Reflect.ownKeys(sourceShape(schema)).filter((key) => !omitted.has(key)));
	return clone(schema, mergeDefs(currDef, {
		shape: newShape,
		checks: []
	}));
}
function extend(schema, shape) {
	if (!isPlainObject(shape)) throw new Error("Invalid input to extend: expected a plain object");
	const checks = schema._zod.def.checks;
	if (checks && checks.length > 0) {
		const existingShape = sourceShape(schema);
		for (const key of Reflect.ownKeys(shape)) if (Object.getOwnPropertyDescriptor(existingShape, key) !== void 0) throw new Error("Cannot overwrite keys on object schemas containing refinements. Use `.safeExtend()` instead.");
	}
	return clone(schema, mergeDefs(schema._zod.def, { shape: extended(schema, shape) }));
}
function extended(schema, shape) {
	const newShape = {};
	mirrorShape(newShape, schema, Reflect.ownKeys(sourceShape(schema)));
	mirrorProps(newShape, shape);
	return newShape;
}
function safeExtend(schema, shape) {
	if (!isPlainObject(shape)) throw new Error("Invalid input to safeExtend: expected a plain object");
	return clone(schema, mergeDefs(schema._zod.def, { shape: extended(schema, shape) }));
}
function merge(a, b) {
	if (!b?._zod?.def) throw new Error("Invalid input to merge: expected an object schema. To merge a plain shape, use `.extend()`.");
	if (a._zod.def.checks?.length) throw new Error(".merge() cannot be used on object schemas containing refinements. Use .safeExtend() instead.");
	const newShape = {};
	mirrorShape(newShape, a, Reflect.ownKeys(sourceShape(a)));
	mirrorShape(newShape, b, Reflect.ownKeys(sourceShape(b)));
	return clone(a, mergeDefs(a._zod.def, {
		shape: newShape,
		get catchall() {
			return b._zod.def.catchall;
		},
		checks: b._zod.def.checks ?? []
	}));
}
function partial(Class, schema, mask, name = "partial") {
	const checks = schema._zod.def.checks;
	if (checks && checks.length > 0) throw new Error(`.${name}() cannot be used on object schemas containing refinements`);
	const selected = mask ? new Set(maskedKeys(schema, mask)) : void 0;
	const newShape = {};
	mirrorShape(newShape, schema, Reflect.ownKeys(sourceShape(schema)), Class && ((value, key) => selected && !selected.has(key) ? value : new Class({
		type: "optional",
		innerType: value
	})));
	return clone(schema, mergeDefs(schema._zod.def, {
		shape: newShape,
		checks: []
	}));
}
function required(Class, schema, mask) {
	const selected = mask ? new Set(maskedKeys(schema, mask)) : void 0;
	const newShape = {};
	mirrorShape(newShape, schema, Reflect.ownKeys(sourceShape(schema)), (value, key) => selected && !selected.has(key) ? value : new Class({
		type: "nonoptional",
		innerType: value
	}));
	return clone(schema, mergeDefs(schema._zod.def, { shape: newShape }));
}
function aborted(x, startIndex = 0) {
	if (x.aborted === true) return true;
	for (let i = startIndex; i < x.issues.length; i++) if (x.issues[i]?.continue !== true) return true;
	return false;
}
function explicitlyAborted(x, startIndex = 0) {
	if (x.aborted === true) return true;
	for (let i = startIndex; i < x.issues.length; i++) if (x.issues[i]?.continue === false) return true;
	return false;
}
function prefixIssues(path, issues) {
	return issues.map((iss) => {
		var _a;
		(_a = iss).path ?? (_a.path = []);
		iss.path.unshift(path);
		return iss;
	});
}
function unwrapMessage(message) {
	return typeof message === "string" ? message : message?.message;
}
/** The leading size checks of `defChecks` that set an upper bound, each paired with it. */
function sizeCaps(defChecks) {
	const caps = [];
	for (const ch of defChecks ?? []) {
		const d = ch._zod.def;
		if (!/_(length|size)$|_equals$/.test(d.check)) break;
		const max = d.maximum ?? d.length ?? d.size;
		if (max >= 0) caps.push([max, ch]);
	}
	return caps;
}
function attachSchema(issues, start, inst) {
	var _a;
	for (let i = start; i < issues.length; i++) (_a = issues[i]).schema ?? (_a.schema = inst);
}
function finalizeIssue(iss, ctx, config) {
	var _a;
	const traits = iss.inst?._zod?.traits;
	if (traits?.has("$ZodType")) {
		if (traits.has("$ZodCheck")) (_a = iss).schema ?? (_a.schema = iss.inst);
		else iss.schema = iss.inst;
	}
	const schemaError = iss.schema !== iss.inst ? iss.schema?._zod.def?.error : void 0;
	const message = iss.message ? iss.message : unwrapMessage(iss.inst?._zod.def?.error?.(iss)) ?? unwrapMessage(schemaError?.(iss)) ?? unwrapMessage(ctx?.error?.(iss)) ?? unwrapMessage(config.customError?.(iss)) ?? unwrapMessage(config.localeError?.(iss)) ?? "Invalid input";
	const full = {};
	for (const k of Object.keys(iss)) {
		if (k === "inst" || k === "schema" || k === "continue" || k === "input" || k === "__proto__") continue;
		full[k] = iss[k];
	}
	full.path ?? (full.path = []);
	full.message = message;
	if (ctx?.reportInput) full.input = iss.input;
	return full;
}
var highSurrogate = /[\uD800-\uDBFF]/;
function codePointLength(str) {
	const units = str.length;
	if (!highSurrogate.test(str)) return units;
	let count = units;
	for (let i = 0; i < units - 1; i++) if ((str.charCodeAt(i) & 64512) === 55296 && (str.charCodeAt(i + 1) & 64512) === 56320) {
		count--;
		i++;
	}
	return count;
}
function getLengthableOrigin(input) {
	if (Array.isArray(input)) return "array";
	if (typeof input === "string") return "string";
	return "unknown";
}
function parsedType(data) {
	const t = typeof data;
	switch (t) {
		case "number": return Number.isNaN(data) ? "nan" : "number";
		case "object": {
			if (data === null) return "null";
			if (Array.isArray(data)) return "array";
			const obj = data;
			if (obj && Object.getPrototypeOf(obj) !== Object.prototype && "constructor" in obj && obj.constructor) return obj.constructor.name;
		}
	}
	return t;
}
function issue(...args) {
	const [iss, input, inst] = args;
	if (typeof iss === "string") return {
		message: iss,
		code: "custom",
		input,
		inst
	};
	return { ...iss };
}
/**
* Installs a trait's members on its prototype. Each value builds that member for the instance on first read; the built value shadows the accessor as an own property, so a detached `const { parse } = schema` keeps working.
*
* Call this from a `proto` initializer, which runs once per prototype — never per instance.
*/
function members(proto, table) {
	for (const key in table) {
		const desc = Object.getOwnPropertyDescriptor(table, key);
		if (desc.get) Object.defineProperty(proto, key, {
			...desc,
			enumerable: false
		});
		else defineBound(proto, key, desc.value);
	}
}
/** Shadows a prototype member with an own value, so a getter that builds from the instance runs once. */
function own(inst, key, value, enumerable = true) {
	Object.defineProperty(inst, key, {
		configurable: true,
		writable: true,
		enumerable,
		value
	});
	return value;
}
/** Like {@link own}, for a member that was never an own data property and has to stay out of `Object.keys`. */
function hide(inst, key, value) {
	return own(inst, key, value, false);
}
/** Adds members a table derives from the instance: each builds on first read and shadows as own data, and assignment shadows the same way, as when these were own properties. */
/* @__NO_SIDE_EFFECTS__ */
function derived(computes, table) {
	for (const key in computes) {
		const compute = computes[key];
		Object.defineProperty(table, key, {
			configurable: true,
			enumerable: true,
			get() {
				return own(this, key, compute(this));
			},
			set(value) {
				own(this, key, value);
			}
		});
	}
	return table;
}
function defineBound(proto, key, fn) {
	Object.defineProperty(proto, key, {
		configurable: true,
		get() {
			return this == null ? fn : own(this, key, fn.bind(this));
		},
		set(value) {
			own(this, key, value);
		}
	});
}
/** Returns the prototype to install on, or `undefined` if this group is already installed on it. */
function claim(inst, sentinel) {
	const proto = Object.getPrototypeOf(inst);
	return sentinel in proto ? void 0 : proto;
}
var installing;
var broke = false;
var breaker = {
	configurable: true,
	get() {
		broke = true;
	}
};
/**
* Installs a lazily-derived internal on the `_zod` prototype of `inst`'s
* constructor, computed from the internals object itself and cached there on
* first read. One accessor per constructor rather than one per instance.
*/
function defineLazyInternal(inst, key, compute) {
	const proto = Object.getPrototypeOf(inst._zod);
	if (key in proto && installing !== inst._zod) {
		installing = void 0;
		return;
	}
	installing = inst._zod;
	Object.defineProperty(proto, key, {
		configurable: true,
		get() {
			Object.defineProperty(this, key, breaker);
			const outer = broke;
			broke = false;
			try {
				const value = compute(this);
				if (broke) delete this[key];
				else Object.defineProperty(this, key, {
					configurable: true,
					writable: true,
					value
				});
				broke = broke || outer;
				return value;
			} catch (err) {
				delete this[key];
				broke = broke || outer;
				throw err;
			}
		},
		set(value) {
			Object.defineProperty(this, key, {
				configurable: true,
				writable: true,
				value
			});
		}
	});
}
/**
* Installs `key` on `inst`'s prototype, computed by `make` on first read and cached there as an own
* data property. One accessor per constructor rather than one per instance, because an own accessor
* puts every instance after the first into v8 dictionary mode. The key doubles as the sentinel.
*/
function installLazyProp(inst, key, make, enumerable) {
	const proto = claim(inst, key);
	if (!proto) return;
	Object.defineProperty(proto, key, {
		configurable: true,
		get() {
			const desc = {
				configurable: true,
				writable: true,
				enumerable,
				value: void 0
			};
			Object.defineProperty(this, key, desc);
			desc.value = make(this);
			Object.defineProperty(this, key, desc);
			return desc.value;
		},
		set(value) {
			Object.defineProperty(this, key, {
				configurable: true,
				writable: true,
				enumerable,
				value
			});
		}
	});
}
/** Marks the thunk `_catch` synthesises for a constant catch value. `Function.length` cannot tell that thunk from a user callback — rest and defaulted parameters both report arity 0 — and a user callback reads `ctx.error`, whose issues only finalize correctly against the caller's per-parse error map. Provenance can say what arity cannot. A plain string key rather than `Symbol.for`, whose call at module scope no bundler can prove pure — the same shape that anchored `urlCanParse` into every build. */
var CONSTANT_CATCH = "~constantCatch";
/** Wraps a constant catch value in a thunk tagged with {@link CONSTANT_CATCH}. */
function constantCatch(value) {
	const fn = () => value;
	fn[CONSTANT_CATCH] = true;
	return fn;
}
// ../../node_modules/.bun/zod@4.6.7/node_modules/zod/v4/core/core.js
var _a$1;
var _zodDesc = {
	value: void 0,
	enumerable: false
};
var _E = "captureStackTrace" in Error ? Error : null;
function newError(Definition) {
	const E = _E;
	if (E) {
		const saved = E.stackTraceLimit;
		if (typeof saved === "number") {
			try {
				E.stackTraceLimit = 0;
			} catch {
				_E = null;
				return new Definition();
			}
			try {
				return new Definition();
			} finally {
				E.stackTraceLimit = saved;
			}
		}
	}
	return new Definition();
}
/* @__NO_SIDE_EFFECTS__ */
function $constructor(name, initializer, proto, params) {
	const zodProto = {};
	function Internals(def) {
		this.def = def;
		this.constr = _;
		this.traits = /* @__PURE__ */ new Set();
	}
	Internals.prototype = zodProto;
	const protoMembers = proto;
	const initialized = protoMembers && /* @__PURE__ */ new WeakSet();
	function init(inst, def) {
		if (!inst._zod) {
			_zodDesc.value = new Internals(def);
			try {
				Object.defineProperty(inst, "_zod", _zodDesc);
			} finally {
				_zodDesc.value = void 0;
			}
		} else if (inst._zod.traits.has(name)) return;
		inst._zod.traits.add(name);
		initializer(inst, def);
		if (initialized) {
			const own = Object.getPrototypeOf(inst);
			const ctorProto = inst._zod.constr.prototype;
			let up = own;
			while (up && up !== ctorProto) up = Object.getPrototypeOf(up);
			const target = up ?? own;
			if (!initialized.has(target)) {
				initialized.add(target);
				members(target, protoMembers);
			}
		}
		const proto = _.prototype;
		for (const k in proto) {
			if (!Object.prototype.hasOwnProperty.call(proto, k)) continue;
			if (!(k in inst)) inst[k] = proto[k].bind(inst);
		}
	}
	const Parent = params?.Parent ?? Object;
	class Definition extends Parent {}
	Object.defineProperty(Definition, "name", { value: name });
	function _(def) {
		const inst = params?.Parent ? newError(Definition) : this;
		init(inst, def);
		const deferred = inst._zod.deferred;
		if (deferred) {
			for (const fn of deferred) fn();
			inst._zod.deferred = void 0;
		}
		const pp = globalThis.__zod_globalConfig?.postProcessor;
		if (pp) pp(inst);
		return inst;
	}
	Object.defineProperty(_, "init", { value: init });
	Object.defineProperty(_, Symbol.hasInstance, { value: (inst) => {
		if (params?.Parent && inst instanceof params.Parent) return true;
		return inst?._zod?.traits?.has(name);
	} });
	Object.defineProperty(_, "name", { value: name });
	return _;
}
var $ZodAsyncError = class extends Error {
	constructor() {
		super(`Encountered Promise during synchronous parse. Use .parseAsync() instead.`);
	}
};
var $ZodEncodeError = class extends Error {
	constructor(name) {
		super(`Encountered unidirectional transform during encode: ${name}`);
		this.name = "ZodEncodeError";
	}
};
(_a$1 = globalThis).__zod_globalConfig ?? (_a$1.__zod_globalConfig = {});
var globalConfig = globalThis.__zod_globalConfig;
function config(newConfig) {
	if (newConfig) Object.assign(globalConfig, newConfig);
	return globalConfig;
}
// ../../node_modules/.bun/zod@4.6.7/node_modules/zod/v4/core/errors.js
function _getMessage() {
	const internals = this._zod;
	internals.message ?? (internals.message = JSON.stringify(internals.def, jsonStringifyReplacer, 2));
	return internals.message;
}
function _setMessage(value) {
	this._zod.message = value;
}
var _messageDesc = {
	get: _getMessage,
	set: _setMessage,
	enumerable: true,
	configurable: true
};
var _issuesDesc = {
	value: void 0,
	enumerable: false
};
var _installedToString = /* @__PURE__ */ new WeakSet([Object.prototype, Error.prototype]);
var initializer$1 = (inst, def) => {
	inst.name = "$ZodError";
	_issuesDesc.value = def;
	Object.defineProperty(inst, "issues", _issuesDesc);
	_issuesDesc.value = void 0;
	Object.defineProperty(inst, "message", _messageDesc);
	const proto = Object.getPrototypeOf(inst);
	if (!_installedToString.has(proto)) {
		_installedToString.add(proto);
		Object.defineProperty(proto, "toString", {
			configurable: true,
			enumerable: false,
			get() {
				const value = () => this.message;
				Object.defineProperty(this, "toString", {
					value,
					configurable: true,
					writable: true
				});
				return value;
			},
			set(value) {
				Object.defineProperty(this, "toString", {
					value,
					configurable: true,
					writable: true
				});
			}
		});
	}
};
var $ZodError = /* @__PURE__ */ $constructor("$ZodError", initializer$1);
/** Get-or-create `obj[key]` as an own data property. A path segment naming an inherited member
* ("toString", "constructor") would otherwise read through to the prototype, and assigning
* "__proto__" would hit the setter instead of creating a key. */
function node(obj, key, make) {
	if (!Object.prototype.hasOwnProperty.call(obj, key)) {
		if (key === "__proto__") Object.defineProperty(obj, key, {
			value: make(),
			writable: true,
			enumerable: true,
			configurable: true
		});
		else obj[key] = make();
	}
	return obj[key];
}
function flattenError(error, mapper = (issue) => issue.message) {
	const fieldErrors = {};
	const formErrors = [];
	for (const sub of error.issues) if (sub.path.length > 0) node(fieldErrors, sub.path[0], () => []).push(mapper(sub));
	else formErrors.push(mapper(sub));
	return {
		formErrors,
		fieldErrors
	};
}
function formatError(error, mapper = (issue) => issue.message) {
	const fieldErrors = { _errors: [] };
	const processError = (error, path = []) => {
		for (const issue of error.issues) if (issue.code === "invalid_union" && issue.errors.length) issue.errors.map((issues) => processError({ issues }, [...path, ...issue.path]));
		else if (issue.code === "invalid_key") processError({ issues: issue.issues }, [...path, ...issue.path]);
		else if (issue.code === "invalid_element") processError({ issues: issue.issues }, [...path, ...issue.path]);
		else {
			const fullpath = [...path, ...issue.path];
			if (fullpath.length === 0) fieldErrors._errors.push(mapper(issue));
			else {
				let curr = fieldErrors;
				let i = 0;
				while (i < fullpath.length) {
					const el = fullpath[i];
					const terminal = i === fullpath.length - 1;
					if (el === "_errors") {
						if (terminal) curr._errors.push(mapper(issue));
						i++;
						continue;
					}
					if (!Object.prototype.hasOwnProperty.call(curr, el)) Object.defineProperty(curr, el, {
						value: { _errors: [] },
						enumerable: true,
						writable: true,
						configurable: true
					});
					const node = curr[el];
					if (terminal) node._errors.push(mapper(issue));
					curr = node;
					i++;
				}
			}
		}
	};
	processError(error);
	return fieldErrors;
}
// ../../node_modules/.bun/zod@4.6.7/node_modules/zod/v4/core/parse.js
function finalizeParams(callee, params) {
	return {
		callee: params?.callee ?? callee,
		Err: params?.Err
	};
}
var _parse = (_Err) => {
	const fn = (schema, value, _ctx, _params) => {
		const ctx = _ctx ? {
			..._ctx,
			async: false
		} : { async: false };
		const result = schema._zod.run({
			value,
			issues: []
		}, ctx);
		if (result instanceof Promise) throw new $ZodAsyncError();
		if (result.issues.length) {
			const e = new ((_params?.Err) ?? _Err)(result.issues.map((iss) => finalizeIssue(iss, ctx, config())));
			captureStackTrace(e, _params?.callee ?? fn);
			throw e;
		}
		return result.value;
	};
	return fn;
};
var _parseAsync = (_Err) => {
	const fn = async (schema, value, _ctx, params) => {
		const ctx = _ctx ? {
			..._ctx,
			async: true
		} : { async: true };
		let result = schema._zod.run({
			value,
			issues: []
		}, ctx);
		if (result instanceof Promise) result = await result;
		if (result.issues.length) {
			const e = new ((params?.Err) ?? _Err)(result.issues.map((iss) => finalizeIssue(iss, ctx, config())));
			captureStackTrace(e, params?.callee ?? fn);
			throw e;
		}
		return result.value;
	};
	return fn;
};
var _safeParse = (_Err) => (schema, value, _ctx) => {
	const ctx = _ctx ? {
		..._ctx,
		async: false
	} : { async: false };
	const result = schema._zod.run({
		value,
		issues: []
	}, ctx);
	if (result instanceof Promise) throw new $ZodAsyncError();
	return result.issues.length ? failure(_Err, result.issues, ctx) : {
		success: true,
		data: result.value
	};
};
function failure(Err, issues, ctx) {
	let error;
	return {
		success: false,
		get error() {
			if (!error) {
				error = new Err(issues.map((iss) => finalizeIssue(iss, ctx, config())));
				issues = void 0;
				ctx = void 0;
			}
			return error;
		},
		set error(e) {
			error = e;
			issues = void 0;
			ctx = void 0;
		}
	};
}
var _safeParseAsync = (_Err) => async (schema, value, _ctx) => {
	const ctx = _ctx ? {
		..._ctx,
		async: true
	} : { async: true };
	let result = schema._zod.run({
		value,
		issues: []
	}, ctx);
	if (result instanceof Promise) result = await result;
	return result.issues.length ? failure(_Err, result.issues, ctx) : {
		success: true,
		data: result.value
	};
};
var COMPILE_INVALID = /* @__PURE__ */ Symbol.for("zod.compile.invalid");
var COMPILE_FALLBACK = /* @__PURE__ */ Symbol.for("zod.compile.fallback");
var validate = ((schema, value, _ctx) => {
	const validator = schema._zod.bag.validator;
	if (validator !== void 0) {
		if (validator(value) !== COMPILE_INVALID) return true;
		if (validator.definite === true && _ctx === void 0) return false;
	}
	return validateFallback(schema, value, _ctx);
});
function validateFallback(schema, value, _ctx) {
	const ctx = _ctx ? {
		..._ctx,
		async: false,
		abortEarly: true
	} : {
		async: false,
		abortEarly: true
	};
	const fallbackRun = schema._zod.bag.fallbackRun;
	let result;
	if (fallbackRun) {
		ctx[COMPILE_FALLBACK] = true;
		result = fallbackRun({
			value,
			issues: []
		}, ctx);
	} else result = schema._zod.run({
		value,
		issues: []
	}, ctx);
	if (result instanceof Promise) throw new $ZodAsyncError();
	return result.issues.length === 0;
}
var validateAsync$1 = async (schema, value, _ctx) => {
	const ctx = _ctx ? {
		..._ctx,
		async: true,
		abortEarly: true
	} : {
		async: true,
		abortEarly: true
	};
	let result = schema._zod.run({
		value,
		issues: []
	}, ctx);
	if (result instanceof Promise) result = await result;
	return result.issues.length === 0;
};
var _encode = (_Err) => {
	const parse = _parse(_Err);
	const fn = (schema, value, _ctx, _params) => {
		const ctx = _ctx ? {
			..._ctx,
			direction: "backward"
		} : { direction: "backward" };
		return parse(schema, value, ctx, finalizeParams(fn, _params));
	};
	return fn;
};
var _decode = (_Err) => {
	const parse = _parse(_Err);
	const fn = (schema, value, _ctx, _params) => {
		return parse(schema, value, _ctx, finalizeParams(fn, _params));
	};
	return fn;
};
var _encodeAsync = (_Err) => {
	const parseAsync = _parseAsync(_Err);
	const fn = async (schema, value, _ctx, _params) => {
		const ctx = _ctx ? {
			..._ctx,
			direction: "backward"
		} : { direction: "backward" };
		return await parseAsync(schema, value, ctx, finalizeParams(fn, _params));
	};
	return fn;
};
var _decodeAsync = (_Err) => {
	const parseAsync = _parseAsync(_Err);
	const fn = async (schema, value, _ctx, _params) => {
		return await parseAsync(schema, value, _ctx, finalizeParams(fn, _params));
	};
	return fn;
};
var _safeEncode = (_Err) => (schema, value, _ctx) => {
	const ctx = _ctx ? {
		..._ctx,
		direction: "backward"
	} : { direction: "backward" };
	return _safeParse(_Err)(schema, value, ctx);
};
var _safeDecode = (_Err) => (schema, value, _ctx) => {
	return _safeParse(_Err)(schema, value, _ctx);
};
var _safeEncodeAsync = (_Err) => async (schema, value, _ctx) => {
	const ctx = _ctx ? {
		..._ctx,
		direction: "backward"
	} : { direction: "backward" };
	return _safeParseAsync(_Err)(schema, value, ctx);
};
var _safeDecodeAsync = (_Err) => async (schema, value, _ctx) => {
	return _safeParseAsync(_Err)(schema, value, _ctx);
};
// ../../node_modules/.bun/zod@4.6.7/node_modules/zod/v4/core/regexes.js
/**
* @deprecated CUID v1 is deprecated by its authors due to information leakage
* (timestamps embedded in the id). Use {@link cuid2} instead.
* See https://github.com/paralleldrive/cuid.
*/
var cuid = /^[cC][0-9a-z]{6,}$/;
var cuid2 = /^[0-9a-z]+$/;
var ulid = /^[0-7][0-9A-HJKMNP-TV-Za-hjkmnp-tv-z]{25}$/;
var xid = /^[0-9a-vA-V]{20}$/;
var ksuid = /^[A-Za-z0-9]{27}$/;
var nanoid = /^[a-zA-Z0-9_-]{21}$/;
function nanoidOfLength(length) {
	return new RegExp(`^[a-zA-Z0-9_-]{${length}}$`);
}
/** ISO 8601-1 duration regex. Does not support the 8601-2 extensions like negative durations or fractional/negative components. */
var duration = /^P(?:(\d+W)|(?!.*W)(?=\d|T\d)(\d+Y)?(\d+M)?(\d+D)?(T(?=\d)(\d+H)?(\d+M)?(\d+([.,]\d+)?S)?)?)$/;
/** A regex for any UUID-like identifier: 8-4-4-4-12 hex pattern */
var guid = /^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/;
/** Returns a regex for validating an RFC 9562/4122 UUID.
*
* @param version Optionally specify a version 1-8. If no version is specified, all versions are supported. */
var uuid = (version) => {
	if (!version) return /^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/;
	return new RegExp(`^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-${version}[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$`);
};
/** Practical email validation */
var email = /^(?:[A-Za-z0-9_'+\-]+\.)*[A-Za-z0-9_'+\-]*[A-Za-z0-9_+-]@(?:[A-Za-z0-9][A-Za-z0-9\-]*\.)+[A-Za-z]{2,}$/;
var _emoji$1 = `^(?=[\\s\\S]*[\\p{Extended_Pictographic}\\p{Regional_Indicator}\\u20E3])[\\p{Extended_Pictographic}\\p{Emoji_Component}]+$`;
function emoji() {
	return new RegExp(_emoji$1, "u");
}
var ipv4 = /^(?:(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])$/;
var ipv6 = /^(([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:))$/;
var cidrv4 = /^((25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\.){3}(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\/([0-9]|[1-2][0-9]|3[0-2])$/;
var cidrv6 = /^(([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:))\/(12[0-8]|1[01][0-9]|[1-9]?[0-9])$/;
var base64 = /^$|^(?:[0-9a-zA-Z+/]{4})*(?:(?:[0-9a-zA-Z+/]{2}==)|(?:[0-9a-zA-Z+/]{3}=))?$/;
var base64url = /^(?:[A-Za-z0-9_-]{4})*(?:[A-Za-z0-9_-]{2,3})?$/;
var httpProtocol = /^https?$/;
var e164 = /^\+[1-9]\d{6,14}$/;
var dateSource = `(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))`;
/** Anchors a pattern source. The interpolation lives here rather than at the call site because
* esbuild will not drop a `@__PURE__` call whose own argument interpolates a variable, but it
* will drop `anchor(dateSource)`. Keeping it inline pinned `date` into every bundle. */
function anchor(source) {
	return new RegExp(`^${source}$`);
}
var date = /*@__PURE__*/ anchor(dateSource);
function timeSource(args) {
	const hhmm = `(?:[01]\\d|2[0-3]):[0-5]\\d`;
	return typeof args.precision === "number" ? args.precision === -1 ? `${hhmm}` : args.precision === 0 ? `${hhmm}:[0-5]\\d` : `${hhmm}:[0-5]\\d\\.\\d{${args.precision}}` : args.seconds ? `${hhmm}:[0-5]\\d(?:\\.\\d+)?` : `${hhmm}(?::[0-5]\\d(?:\\.\\d+)?)?`;
}
function time(args) {
	return new RegExp(`^${timeSource(args)}$`);
}
function datetime(args) {
	const opts = ["Z"];
	if (args.offset) opts.push(`([+-](?:[01]\\d|2[0-3]):[0-5]\\d)`);
	const qualified = `${timeSource({
		precision: args.precision,
		seconds: true
	})}(?:${opts.join("|")})`;
	const timeRegex = args.local ? `${qualified}|${timeSource({ precision: args.precision })}` : qualified;
	return new RegExp(`^${dateSource}T(?:${timeRegex})$`);
}
var anyString = /^[\s\S]{0,}$/;
var integer = /^-?\d+$/;
var number$1 = /^-?\d+(?:\.\d+)?$/;
var boolean$1 = /^(?:true|false)$/i;
var lowercase = /^[^A-Z]*$/;
var uppercase = /^[^a-z]*$/;
// ../../node_modules/.bun/zod@4.6.7/node_modules/zod/v4/core/checks.js
var $ZodCheck = /*@__PURE__*/ $constructor("$ZodCheck", (inst, def) => {
	var _a;
	inst._zod ?? (inst._zod = {});
	inst._zod.def = def;
	(_a = inst._zod).onattach ?? (_a.onattach = []);
});
/** Default `when` for length-based checks: run only on non-nullish values with a `length`. */
var _whenHasLength = (payload) => {
	const val = payload.value;
	return !nullish(val) && val.length !== void 0;
};
var numericOriginMap = {
	number: "number",
	bigint: "bigint",
	object: "date"
};
var $ZodCheckLessThan = /*@__PURE__*/ $constructor("$ZodCheckLessThan", (inst, def) => {
	$ZodCheck.init(inst, def);
	const origin = numericOriginMap[typeof def.value];
	inst._zod.check = (payload) => {
		if (def.inclusive ? payload.value <= def.value : payload.value < def.value) return;
		payload.issues.push({
			origin: numericOriginMap[typeof payload.value] ?? origin,
			code: "too_big",
			maximum: typeof def.value === "object" ? def.value.getTime() : def.value,
			input: payload.value,
			inclusive: def.inclusive,
			inst,
			continue: !def.abort
		});
	};
});
var $ZodCheckGreaterThan = /*@__PURE__*/ $constructor("$ZodCheckGreaterThan", (inst, def) => {
	$ZodCheck.init(inst, def);
	const origin = numericOriginMap[typeof def.value];
	inst._zod.check = (payload) => {
		if (def.inclusive ? payload.value >= def.value : payload.value > def.value) return;
		payload.issues.push({
			origin: numericOriginMap[typeof payload.value] ?? origin,
			code: "too_small",
			minimum: typeof def.value === "object" ? def.value.getTime() : def.value,
			input: payload.value,
			inclusive: def.inclusive,
			inst,
			continue: !def.abort
		});
	};
});
var $ZodCheckMultipleOf = /*@__PURE__*/ $constructor("$ZodCheckMultipleOf", (inst, def) => {
	$ZodCheck.init(inst, def);
	inst._zod.check = (payload) => {
		if (typeof payload.value !== typeof def.value) throw new Error("Cannot mix number and bigint in multiple_of check.");
		if (typeof payload.value === "bigint" ? def.value !== BigInt(0) && payload.value % def.value === BigInt(0) : floatSafeRemainder(payload.value, def.value) === 0) return;
		payload.issues.push({
			origin: typeof payload.value,
			code: "not_multiple_of",
			divisor: def.value,
			input: payload.value,
			inst,
			continue: !def.abort
		});
	};
});
var $ZodCheckNumberFormat = /*@__PURE__*/ $constructor("$ZodCheckNumberFormat", (inst, def) => {
	$ZodCheck.init(inst, def);
	def.format = def.format || "float64";
	const isInt = def.format?.includes("int");
	const origin = isInt ? "int" : "number";
	const [minimum, maximum] = NUMBER_FORMAT_RANGES[def.format];
	inst._zod.check = (payload) => {
		const input = payload.value;
		if (isInt) {
			if (!Number.isInteger(input)) {
				payload.issues.push({
					expected: origin,
					format: def.format,
					code: "invalid_type",
					continue: false,
					input,
					inst
				});
				return;
			}
			if (!Number.isSafeInteger(input)) {
				if (input > 0) payload.issues.push({
					input,
					code: "too_big",
					maximum: Number.MAX_SAFE_INTEGER,
					note: "Integers must be within the safe integer range.",
					inst,
					origin,
					inclusive: true,
					continue: !def.abort
				});
				else payload.issues.push({
					input,
					code: "too_small",
					minimum: Number.MIN_SAFE_INTEGER,
					note: "Integers must be within the safe integer range.",
					inst,
					origin,
					inclusive: true,
					continue: !def.abort
				});
				return;
			}
		}
		if (input < minimum) payload.issues.push({
			origin: "number",
			input,
			code: "too_small",
			minimum,
			inclusive: true,
			inst,
			continue: !def.abort
		});
		if (input > maximum) payload.issues.push({
			origin: "number",
			input,
			code: "too_big",
			maximum,
			inclusive: true,
			inst,
			continue: !def.abort
		});
	};
});
var $ZodCheckMaxLength = /*@__PURE__*/ $constructor("$ZodCheckMaxLength", (inst, def) => {
	var _a;
	$ZodCheck.init(inst, def);
	(_a = inst._zod.def).when ?? (_a.when = _whenHasLength);
	inst._zod.check = (payload) => {
		const input = payload.value;
		const units = input.length;
		if ((typeof input === "string" && units > def.maximum ? codePointLength(input) : units) <= def.maximum) return;
		const origin = getLengthableOrigin(input);
		payload.issues.push({
			origin,
			code: "too_big",
			maximum: def.maximum,
			inclusive: true,
			input,
			inst,
			continue: !def.abort
		});
	};
});
var $ZodCheckMinLength = /*@__PURE__*/ $constructor("$ZodCheckMinLength", (inst, def) => {
	var _a;
	$ZodCheck.init(inst, def);
	(_a = inst._zod.def).when ?? (_a.when = _whenHasLength);
	inst._zod.check = (payload) => {
		const input = payload.value;
		const units = input.length;
		if ((typeof input === "string" && units >= def.minimum && units < def.minimum * 2 ? codePointLength(input) : units) >= def.minimum) return;
		const origin = getLengthableOrigin(input);
		payload.issues.push({
			origin,
			code: "too_small",
			minimum: def.minimum,
			inclusive: true,
			input,
			inst,
			continue: !def.abort
		});
	};
});
var $ZodCheckLengthEquals = /*@__PURE__*/ $constructor("$ZodCheckLengthEquals", (inst, def) => {
	var _a;
	$ZodCheck.init(inst, def);
	(_a = inst._zod.def).when ?? (_a.when = _whenHasLength);
	inst._zod.check = (payload) => {
		const input = payload.value;
		const units = input.length;
		const length = typeof input === "string" && units >= def.length && units <= def.length * 2 ? codePointLength(input) : units;
		if (length === def.length) return;
		const origin = getLengthableOrigin(input);
		const tooBig = length > def.length;
		payload.issues.push({
			origin,
			...tooBig ? {
				code: "too_big",
				maximum: def.length
			} : {
				code: "too_small",
				minimum: def.length
			},
			inclusive: true,
			exact: true,
			input: payload.value,
			inst,
			continue: !def.abort
		});
	};
});
var $ZodCheckStringFormat = /*@__PURE__*/ $constructor("$ZodCheckStringFormat", (inst, def) => {
	var _a, _b;
	$ZodCheck.init(inst, def);
	if (def.pattern) (_a = inst._zod).check ?? (_a.check = (payload) => {
		def.pattern.lastIndex = 0;
		if (def.pattern.test(payload.value)) return;
		payload.issues.push({
			origin: "string",
			code: "invalid_format",
			format: def.format,
			input: payload.value,
			...def.pattern ? { pattern: def.pattern.toString() } : {},
			inst,
			continue: !def.abort
		});
	});
	else (_b = inst._zod).check ?? (_b.check = () => {});
});
var $ZodCheckRegex = /*@__PURE__*/ $constructor("$ZodCheckRegex", (inst, def) => {
	$ZodCheckStringFormat.init(inst, def);
	inst._zod.check = (payload) => {
		def.pattern.lastIndex = 0;
		if (def.pattern.test(payload.value)) return;
		payload.issues.push({
			origin: "string",
			code: "invalid_format",
			format: "regex",
			input: payload.value,
			pattern: def.pattern.toString(),
			inst,
			continue: !def.abort
		});
	};
});
var $ZodCheckLowerCase = /*@__PURE__*/ $constructor("$ZodCheckLowerCase", (inst, def) => {
	def.pattern ?? (def.pattern = lowercase);
	$ZodCheckStringFormat.init(inst, def);
});
var $ZodCheckUpperCase = /*@__PURE__*/ $constructor("$ZodCheckUpperCase", (inst, def) => {
	def.pattern ?? (def.pattern = uppercase);
	$ZodCheckStringFormat.init(inst, def);
});
var $ZodCheckIncludes = /*@__PURE__*/ $constructor("$ZodCheckIncludes", (inst, def) => {
	$ZodCheck.init(inst, def);
	const escapedRegex = escapeRegex(def.includes);
	def.pattern = new RegExp(typeof def.position === "number" ? `^.{${def.position},}${escapedRegex}` : escapedRegex);
	inst._zod.check = (payload) => {
		if (payload.value.includes(def.includes, def.position)) return;
		payload.issues.push({
			origin: "string",
			code: "invalid_format",
			format: "includes",
			includes: def.includes,
			input: payload.value,
			inst,
			continue: !def.abort
		});
	};
});
var $ZodCheckStartsWith = /*@__PURE__*/ $constructor("$ZodCheckStartsWith", (inst, def) => {
	$ZodCheck.init(inst, def);
	const pattern = new RegExp(`^${escapeRegex(def.prefix)}.*`);
	def.pattern ?? (def.pattern = pattern);
	inst._zod.check = (payload) => {
		if (payload.value.startsWith(def.prefix)) return;
		payload.issues.push({
			origin: "string",
			code: "invalid_format",
			format: "starts_with",
			prefix: def.prefix,
			input: payload.value,
			inst,
			continue: !def.abort
		});
	};
});
var $ZodCheckEndsWith = /*@__PURE__*/ $constructor("$ZodCheckEndsWith", (inst, def) => {
	$ZodCheck.init(inst, def);
	const pattern = new RegExp(`.*${escapeRegex(def.suffix)}$`);
	def.pattern ?? (def.pattern = pattern);
	inst._zod.check = (payload) => {
		if (payload.value.endsWith(def.suffix)) return;
		payload.issues.push({
			origin: "string",
			code: "invalid_format",
			format: "ends_with",
			suffix: def.suffix,
			input: payload.value,
			inst,
			continue: !def.abort
		});
	};
});
var $ZodCheckOverwrite = /*@__PURE__*/ $constructor("$ZodCheckOverwrite", (inst, def) => {
	$ZodCheck.init(inst, def);
	inst._zod.check = (payload) => {
		payload.value = def.tx(payload.value);
	};
});
// ../../node_modules/.bun/zod@4.6.7/node_modules/zod/v4/core/doc.js
var Doc = class {
	constructor(args = [], closed = {}) {
		this.content = [];
		this.indent = 0;
		this.args = args;
		this.closed = closed;
	}
	indented(fn) {
		this.indent += 1;
		try {
			fn(this);
		} finally {
			this.indent -= 1;
		}
	}
	write(arg) {
		if (typeof arg === "function") {
			arg(this, { execution: "sync" });
			arg(this, { execution: "async" });
			return;
		}
		const lines = arg.split("\n").filter((x) => x);
		const minIndent = Math.min(...lines.map((x) => x.length - x.trimStart().length));
		const dedented = lines.map((x) => x.slice(minIndent)).map((x) => " ".repeat(this.indent * 2) + x);
		for (const line of dedented) this.content.push(line);
	}
	compile() {
		const F = Function;
		const content = this?.content ?? [``];
		return new F(...Object.keys(this.closed), `return function (${this.args.join(", ")}) {\n${content.join("\n")}\n};`)(...Object.values(this.closed));
	}
};
// ../../node_modules/.bun/zod@4.6.7/node_modules/zod/v4/core/versions.js
var version = {
	major: 4,
	minor: 6,
	patch: 7
};
// ../../node_modules/.bun/zod@4.6.7/node_modules/zod/v4/core/schemas.js
var $ZodType = /*@__PURE__*/ $constructor("$ZodType", (inst, def) => {
	var _a;
	inst ?? (inst = {});
	inst._zod.def = def;
	inst._zod.bag = inst._zod.bag || {};
	inst._zod.version = version;
	const defChecks = inst._zod.def.checks;
	const checks = inst._zod.traits.has("$ZodCheck") ? [inst, ...defChecks ?? []] : defChecks?.length ? [...defChecks] : [];
	for (const ch of checks) for (const fn of ch._zod.onattach) fn(inst);
	if (checks.length === 0) {
		(_a = inst._zod).deferred ?? (_a.deferred = []);
		inst._zod.deferred?.push(() => {
			inst._zod.run = inst._zod.parse;
		});
	} else {
		const runChecks = (payload, checks, ctx) => {
			if (payload.memo) return payload;
			let isAborted = aborted(payload);
			let asyncResult;
			for (const ch of checks) {
				if (ch._zod.def.when) {
					if (explicitlyAborted(payload)) continue;
					if (!ch._zod.def.when(payload)) continue;
				} else if (isAborted) continue;
				const currLen = payload.issues.length;
				const _ = ch._zod.check(payload);
				if (_ instanceof Promise && ctx?.async === false) throw new $ZodAsyncError();
				if (asyncResult || _ instanceof Promise) asyncResult = (asyncResult ?? Promise.resolve()).then(async () => {
					await _;
					if (payload.issues.length === currLen) return;
					attachSchema(payload.issues, currLen, inst);
					if (!isAborted) isAborted = aborted(payload, currLen);
				});
				else {
					if (payload.issues.length === currLen) continue;
					attachSchema(payload.issues, currLen, inst);
					if (!isAborted) isAborted = aborted(payload, currLen);
				}
			}
			if (asyncResult) return asyncResult.then(() => {
				return payload;
			});
			return payload;
		};
		const handleCanaryResult = (canary, payload, ctx) => {
			if (aborted(canary)) {
				canary.aborted = true;
				return canary;
			}
			const checkResult = runChecks(payload, checks, ctx);
			if (checkResult instanceof Promise) {
				if (ctx.async === false) throw new $ZodAsyncError();
				return checkResult.then((checkResult) => inst._zod.parse(checkResult, ctx));
			}
			return inst._zod.parse(checkResult, ctx);
		};
		inst._zod.run = (payload, ctx) => {
			if (ctx.skipChecks) return inst._zod.parse(payload, ctx);
			if (ctx.direction === "backward") {
				const canary = inst._zod.parse({
					value: payload.value,
					issues: []
				}, {
					...ctx,
					skipChecks: true
				});
				if (canary instanceof Promise) return canary.then((canary) => {
					return handleCanaryResult(canary, payload, ctx);
				});
				return handleCanaryResult(canary, payload, ctx);
			}
			const result = inst._zod.parse(payload, ctx);
			if (result instanceof Promise) {
				if (ctx.async === false) throw new $ZodAsyncError();
				return result.then((result) => runChecks(result, checks, ctx));
			}
			return runChecks(result, checks, ctx);
		};
	}
}, {
	get "~standard"() {
		return hide(this, "~standard", standardProps(this));
	},
	set "~standard"(value) {
		own(this, "~standard", value);
	}
});
/** The Standard Schema surface for `inst`. Shared so wrappers can extend it without forcing it. */
var toStandardResult = (r, ctx) => r.issues.length ? { issues: r.issues.map((iss) => finalizeIssue(iss, ctx, config())) } : { value: r.value };
async function validateAsync(inst, value) {
	const ctx = { async: true };
	return toStandardResult(await inst._zod.run({
		value,
		issues: []
	}, ctx), ctx);
}
function standardProps(inst) {
	return {
		validate: (value) => {
			const ctx = { async: false };
			try {
				const r = inst._zod.run({
					value,
					issues: []
				}, ctx);
				if (!(r instanceof Promise)) return toStandardResult(r, ctx);
			} catch (_) {}
			return validateAsync(inst, value);
		},
		vendor: "zod",
		version: 1
	};
}
var $ZodString = /*@__PURE__*/ $constructor("$ZodString", (inst, def) => {
	$ZodType.init(inst, def);
	inst._zod.pattern = def.pattern ?? anyString;
	inst._zod.parse = (payload, _) => {
		if (def.coerce) try {
			payload.value = String(payload.value);
		} catch (_) {}
		if (typeof payload.value === "string") return payload;
		payload.issues.push({
			expected: "string",
			code: "invalid_type",
			input: payload.value,
			inst
		});
		return payload;
	};
});
var $ZodStringFormat = /*@__PURE__*/ $constructor("$ZodStringFormat", (inst, def) => {
	$ZodCheckStringFormat.init(inst, def);
	$ZodString.init(inst, def);
});
var $ZodGUID = /*@__PURE__*/ $constructor("$ZodGUID", (inst, def) => {
	def.pattern ?? (def.pattern = guid);
	$ZodStringFormat.init(inst, def);
});
var $ZodUUID = /*@__PURE__*/ $constructor("$ZodUUID", (inst, def) => {
	if (def.version) {
		const v = {
			v1: 1,
			v2: 2,
			v3: 3,
			v4: 4,
			v5: 5,
			v6: 6,
			v7: 7,
			v8: 8
		}[def.version];
		if (v === void 0) throw new Error(`Invalid UUID version: "${def.version}"`);
		def.pattern ?? (def.pattern = uuid(v));
	} else def.pattern ?? (def.pattern = uuid());
	$ZodStringFormat.init(inst, def);
});
var $ZodEmail = /*@__PURE__*/ $constructor("$ZodEmail", (inst, def) => {
	def.pattern ?? (def.pattern = email);
	$ZodStringFormat.init(inst, def);
});
function canParseURL(input) {
	try {
		if (typeof URL !== "undefined" && typeof URL.canParse === "function") return URL.canParse(input);
		new URL(input);
		return true;
	} catch {
		return false;
	}
}
function validateURL(trimmed, def) {
	if (!("normalize" in def) && !("hostname" in def) && !("protocol" in def)) return canParseURL(trimmed) || 2;
	return parseURLObject(trimmed, def);
}
/** Parses a URL while preserving the non-normalizing HTTP guard. */
function parseURLObject(trimmed, def) {
	if (!def.normalize && def.protocol?.source === httpProtocol.source && !/^https?:\/\//i.test(trimmed)) return 1;
	try {
		if (typeof URL !== "undefined") {
			const URLStatic = URL;
			if (typeof URLStatic.parse === "function") return URLStatic.parse(trimmed) ?? 2;
		}
		return new URL(trimmed);
	} catch {
		return 2;
	}
}
var asciiTabOrNewline = /[\t\n\r]/g;
/** The URL parser deletes every ASCII tab, LF and CR from its input before it parses, so `new URL("https://exa\nmple.com")` reports on `example.com`. Applying the same deletion to the returned value closes the half of that divergence which can move the host; the parser's other rewrite, stripping C0 controls at the edges, cannot. */
function stripTabAndNewline(value) {
	return value.replace(asciiTabOrNewline, "");
}
function urlHostnameOk(url, hostname) {
	hostname.lastIndex = 0;
	return hostname.test(url.hostname);
}
function urlProtocolOk(url, protocol) {
	protocol.lastIndex = 0;
	return protocol.test(url.protocol.endsWith(":") ? url.protocol.slice(0, -1) : url.protocol);
}
var $ZodURL = /*@__PURE__*/ $constructor("$ZodURL", (inst, def) => {
	$ZodStringFormat.init(inst, def);
	inst._zod.check = (payload) => {
		try {
			const trimmed = payload.value.trim();
			const url = validateURL(trimmed, def);
			if (url === 1) {
				payload.issues.push({
					code: "invalid_format",
					format: "url",
					note: "Invalid URL format",
					input: payload.value,
					inst,
					continue: !def.abort
				});
				return;
			}
			if (url === 2) {
				payload.issues.push({
					code: "invalid_format",
					format: "url",
					input: payload.value,
					inst,
					continue: !def.abort
				});
				return;
			}
			if (url === true) {
				payload.value = stripTabAndNewline(trimmed);
				return;
			}
			if (def.hostname && !urlHostnameOk(url, def.hostname)) payload.issues.push({
				code: "invalid_format",
				format: "url",
				note: "Invalid hostname",
				pattern: def.hostname.source,
				input: payload.value,
				inst,
				continue: !def.abort
			});
			if (def.protocol && !urlProtocolOk(url, def.protocol)) payload.issues.push({
				code: "invalid_format",
				format: "url",
				note: "Invalid protocol",
				pattern: def.protocol.source,
				input: payload.value,
				inst,
				continue: !def.abort
			});
			payload.value = def.normalize ? url.href : stripTabAndNewline(trimmed);
			return;
		} catch (_) {
			payload.issues.push({
				code: "invalid_format",
				format: "url",
				input: payload.value,
				inst,
				continue: !def.abort
			});
		}
	};
});
var $ZodEmoji = /*@__PURE__*/ $constructor("$ZodEmoji", (inst, def) => {
	def.pattern ?? (def.pattern = emoji());
	$ZodStringFormat.init(inst, def);
});
var $ZodNanoID = /*@__PURE__*/ $constructor("$ZodNanoID", (inst, def) => {
	if (def.length !== void 0 && (!Number.isInteger(def.length) || def.length < 1)) throw new Error(`Invalid nanoid length: ${def.length}`);
	def.pattern ?? (def.pattern = def.length === void 0 ? nanoid : nanoidOfLength(def.length));
	$ZodStringFormat.init(inst, def);
});
/**
* @deprecated CUID v1 is deprecated by its authors due to information leakage
* (timestamps embedded in the id). Use {@link $ZodCUID2} instead.
* See https://github.com/paralleldrive/cuid.
*/
var $ZodCUID = /*@__PURE__*/ $constructor("$ZodCUID", (inst, def) => {
	def.pattern ?? (def.pattern = cuid);
	$ZodStringFormat.init(inst, def);
});
var $ZodCUID2 = /*@__PURE__*/ $constructor("$ZodCUID2", (inst, def) => {
	def.pattern ?? (def.pattern = cuid2);
	$ZodStringFormat.init(inst, def);
});
var $ZodULID = /*@__PURE__*/ $constructor("$ZodULID", (inst, def) => {
	def.pattern ?? (def.pattern = ulid);
	$ZodStringFormat.init(inst, def);
});
var $ZodXID = /*@__PURE__*/ $constructor("$ZodXID", (inst, def) => {
	def.pattern ?? (def.pattern = xid);
	$ZodStringFormat.init(inst, def);
});
var $ZodKSUID = /*@__PURE__*/ $constructor("$ZodKSUID", (inst, def) => {
	def.pattern ?? (def.pattern = ksuid);
	$ZodStringFormat.init(inst, def);
});
var $ZodISODateTime = /*@__PURE__*/ $constructor("$ZodISODateTime", (inst, def) => {
	def.pattern ?? (def.pattern = datetime(def));
	$ZodStringFormat.init(inst, def);
});
var $ZodISODate = /*@__PURE__*/ $constructor("$ZodISODate", (inst, def) => {
	def.pattern ?? (def.pattern = date);
	$ZodStringFormat.init(inst, def);
});
var $ZodISOTime = /*@__PURE__*/ $constructor("$ZodISOTime", (inst, def) => {
	def.pattern ?? (def.pattern = time(def));
	$ZodStringFormat.init(inst, def);
});
var $ZodISODuration = /*@__PURE__*/ $constructor("$ZodISODuration", (inst, def) => {
	def.pattern ?? (def.pattern = duration);
	$ZodStringFormat.init(inst, def);
});
var $ZodIPv4 = /*@__PURE__*/ $constructor("$ZodIPv4", (inst, def) => {
	def.pattern ?? (def.pattern = ipv4);
	$ZodStringFormat.init(inst, def);
});
/** An IPv6 address is written with hex digits, colons and dots, and nothing else. The guard is what makes the check below an IPv6 check: `new URL("http://[...]")` parses an authority, not an address, so `@` and `\` re-delimit it and `"::@1\\"` validates against the host `0.0.0.1`. The URL parser also deletes ASCII tab, LF and CR rather than failing, which is how `"::1\n"` validated as `::1`. */
var ipv6Alphabet = /^[0-9a-fA-F:.]+$/;
function isValidIPv6(value) {
	if (!ipv6Alphabet.test(value)) return false;
	return canParseURL(`http://[${value}]`);
}
var $ZodIPv6 = /*@__PURE__*/ $constructor("$ZodIPv6", (inst, def) => {
	def.pattern ?? (def.pattern = ipv6);
	$ZodStringFormat.init(inst, def);
	inst._zod.check = (payload) => {
		if (!isValidIPv6(payload.value)) payload.issues.push({
			code: "invalid_format",
			format: "ipv6",
			input: payload.value,
			inst,
			continue: !def.abort
		});
	};
});
var $ZodCIDRv4 = /*@__PURE__*/ $constructor("$ZodCIDRv4", (inst, def) => {
	def.pattern ?? (def.pattern = cidrv4);
	$ZodStringFormat.init(inst, def);
});
function isValidCIDRv6(value) {
	const parts = value.split("/");
	if (parts.length !== 2) return false;
	const [address, prefix] = parts;
	if (!prefix) return false;
	const prefixNum = Number(prefix);
	if (`${prefixNum}` !== prefix) return false;
	if (prefixNum < 0 || prefixNum > 128) return false;
	return isValidIPv6(address);
}
var $ZodCIDRv6 = /*@__PURE__*/ $constructor("$ZodCIDRv6", (inst, def) => {
	def.pattern ?? (def.pattern = cidrv6);
	$ZodStringFormat.init(inst, def);
	inst._zod.check = (payload) => {
		if (!isValidCIDRv6(payload.value)) payload.issues.push({
			code: "invalid_format",
			format: "cidrv6",
			input: payload.value,
			inst,
			continue: !def.abort
		});
	};
});
function isValidBase64(data) {
	if (data === "") return true;
	if (/\s/.test(data)) return false;
	if (data.length % 4 !== 0) return false;
	try {
		atob(data);
		return true;
	} catch {
		return false;
	}
}
var base64Charset = /^[0-9a-zA-Z+/]*={0,2}$/;
var $ZodBase64 = /*@__PURE__*/ $constructor("$ZodBase64", (inst, def) => {
	def.pattern ?? (def.pattern = base64Charset);
	$ZodStringFormat.init(inst, def);
	inst._zod.check = (payload) => {
		if (isValidBase64(payload.value)) return;
		payload.issues.push({
			code: "invalid_format",
			format: "base64",
			input: payload.value,
			inst,
			continue: !def.abort
		});
	};
});
var base64urlCharset = /^[A-Za-z0-9_-]*$/;
function isValidBase64URL(data) {
	if (!base64urlCharset.test(data)) return false;
	const base64 = data.replace(/[-_]/g, (c) => c === "-" ? "+" : "/");
	return isValidBase64(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="));
}
var $ZodBase64URL = /*@__PURE__*/ $constructor("$ZodBase64URL", (inst, def) => {
	def.pattern ?? (def.pattern = base64urlCharset);
	$ZodStringFormat.init(inst, def);
	inst._zod.check = (payload) => {
		if (isValidBase64URL(payload.value)) return;
		payload.issues.push({
			code: "invalid_format",
			format: "base64url",
			input: payload.value,
			inst,
			continue: !def.abort
		});
	};
});
var $ZodE164 = /*@__PURE__*/ $constructor("$ZodE164", (inst, def) => {
	def.pattern ?? (def.pattern = e164);
	$ZodStringFormat.init(inst, def);
});
function isValidJWT(token, algorithm = null) {
	try {
		const tokensParts = token.split(".");
		if (tokensParts.length !== 3) return false;
		const [header] = tokensParts;
		if (!header) return false;
		const parsedHeader = JSON.parse(atob(header));
		if ("typ" in parsedHeader && parsedHeader?.typ !== "JWT") return false;
		if (!parsedHeader.alg) return false;
		if (algorithm && (!("alg" in parsedHeader) || parsedHeader.alg !== algorithm)) return false;
		return true;
	} catch {
		return false;
	}
}
var $ZodJWT = /*@__PURE__*/ $constructor("$ZodJWT", (inst, def) => {
	$ZodStringFormat.init(inst, def);
	inst._zod.check = (payload) => {
		if (isValidJWT(payload.value, def.alg)) return;
		payload.issues.push({
			code: "invalid_format",
			format: "jwt",
			input: payload.value,
			inst,
			continue: !def.abort
		});
	};
});
var $ZodNumber = /*@__PURE__*/ $constructor("$ZodNumber", (inst, def) => {
	$ZodType.init(inst, def);
	inst._zod.pattern = number$1;
	inst._zod.parse = (payload, _ctx) => {
		if (def.coerce) try {
			payload.value = Number(payload.value);
		} catch (_) {}
		const input = payload.value;
		if (typeof input === "number" && !Number.isNaN(input) && Number.isFinite(input)) return payload;
		const received = typeof input === "number" ? Number.isNaN(input) ? "NaN" : !Number.isFinite(input) ? String(input) : void 0 : void 0;
		payload.issues.push({
			expected: "number",
			code: "invalid_type",
			input,
			inst,
			...received ? { received } : {}
		});
		return payload;
	};
});
var $ZodNumberFormat = /*@__PURE__*/ $constructor("$ZodNumberFormat", (inst, def) => {
	$ZodCheckNumberFormat.init(inst, def);
	$ZodNumber.init(inst, def);
});
var $ZodBoolean = /*@__PURE__*/ $constructor("$ZodBoolean", (inst, def) => {
	$ZodType.init(inst, def);
	inst._zod.pattern = boolean$1;
	inst._zod.parse = (payload, _ctx) => {
		if (def.coerce) try {
			payload.value = Boolean(payload.value);
		} catch (_) {}
		const input = payload.value;
		if (typeof input === "boolean") return payload;
		payload.issues.push({
			expected: "boolean",
			code: "invalid_type",
			input,
			inst
		});
		return payload;
	};
});
var $ZodUnknown = /*@__PURE__*/ $constructor("$ZodUnknown", (inst, def) => {
	$ZodType.init(inst, def);
	inst._zod.parse = (payload) => payload;
});
var $ZodNever = /*@__PURE__*/ $constructor("$ZodNever", (inst, def) => {
	$ZodType.init(inst, def);
	inst._zod.parse = (payload, _ctx) => {
		payload.issues.push({
			expected: "never",
			code: "invalid_type",
			input: payload.value,
			inst
		});
		return payload;
	};
});
function capSize(inst, size) {
	const caps = sizeCaps(inst._zod.def.checks);
	if (!caps.length) return;
	const cap = Math.min(...caps.map((c) => c[0]));
	const parse = inst._zod.parse;
	inst._zod.parse = (payload, ctx) => {
		const n = size(payload.value);
		if (n > cap && !ctx?.skipChecks && ctx?.direction !== "backward") {
			for (const [max, ch] of sizeCaps(inst._zod.def.checks)) if (n > max && ch._zod.def.when(payload)) {
				const start = payload.issues.length;
				ch._zod.check(payload);
				payload.issues[start].continue = false;
				attachSchema(payload.issues, start, inst);
				return payload;
			}
		}
		return parse(payload, ctx);
	};
}
var arraySize = (input) => Array.isArray(input) ? input.length : -1;
function handleArrayResult(result, final, index) {
	if (result.issues.length) final.issues.push(...prefixIssues(index, result.issues));
	final.value[index] = result.value;
}
var $ZodArray = /*@__PURE__*/ $constructor("$ZodArray", (inst, def) => {
	$ZodType.init(inst, def);
	const memo = globalConfig.memoizer;
	memo?.attach(inst);
	inst._zod.parse = (payload, ctx) => {
		const input = payload.value;
		if (!Array.isArray(input)) {
			payload.issues.push({
				expected: "array",
				code: "invalid_type",
				input,
				inst
			});
			return payload;
		}
		payload.value = memo ? memo.alloc(inst, payload, Array(input.length), ctx) : Array(input.length);
		const proms = [];
		const abortEarly = ctx?.abortEarly;
		for (let i = 0; i < input.length; i++) {
			const item = input[i];
			const result = def.element._zod.run({
				value: item,
				issues: []
			}, ctx);
			if (result instanceof Promise) proms.push(result.then((result) => handleArrayResult(result, payload, i)));
			else {
				handleArrayResult(result, payload, i);
				if (abortEarly && result.issues.length !== 0 && aborted(result)) break;
			}
		}
		if (proms.length) return Promise.all(proms).then(() => payload);
		return payload;
	};
	capSize(inst, arraySize);
});
function handlePropertyResult(result, final, key, input, optin, optout) {
	const isPresent = key in input;
	const isOptionalOut = optout === "optional";
	if (!isPresent && isOptionalOut && optin === "optional") return;
	if (result.issues.length) {
		if (optin !== void 0 && isOptionalOut && !isPresent) return;
		final.issues.push(...prefixIssues(key, result.issues));
	}
	if (!isPresent && optin === void 0) {
		if (!result.issues.length) final.issues.push({
			code: "invalid_type",
			expected: "nonoptional",
			input: void 0,
			path: [key]
		});
		return;
	}
	if (result.value === void 0) {
		if (isPresent || optin === "defaulted" && !isOptionalOut) final.value[key] = void 0;
	} else final.value[key] = result.value;
}
var NO_SYMBOL_KEYS = [];
function normalizeDef(def) {
	const keys = Object.keys(def.shape);
	const ownSymbols = Object.getOwnPropertySymbols(def.shape);
	const symbolKeys = ownSymbols.length ? ownSymbols : NO_SYMBOL_KEYS;
	const allKeys = symbolKeys.length ? [...keys, ...symbolKeys] : keys;
	for (const k of allKeys) if (!def.shape?.[k]?._zod?.traits?.has("$ZodType")) throw new Error(`Invalid element at key "${String(k)}": expected a Zod schema`);
	const okeys = optionalKeys(def.shape);
	return {
		...def,
		allKeys,
		symbolKeys,
		keySet: new Set(keys),
		numKeys: keys.length,
		optionalKeys: new Set(okeys)
	};
}
function handleCatchall(proms, input, payload, ctx, def, inst, abortEarly) {
	const unrecognized = [];
	const keySet = def.keySet;
	const _catchall = def.catchall._zod;
	const t = _catchall.def.type;
	const optin = _catchall.optin;
	const optout = _catchall.optout;
	let seen = 0;
	for (const key in input) {
		if (abortEarly && payload.issues.length !== seen) {
			if (aborted(payload, seen)) break;
			seen = payload.issues.length;
		}
		if (keySet.has(key)) continue;
		if (key === "__proto__") {
			if (t === "never") unrecognized.push(key);
			continue;
		}
		if (t === "never") {
			unrecognized.push(key);
			continue;
		}
		const r = _catchall.run({
			value: input[key],
			issues: []
		}, ctx);
		if (r instanceof Promise) proms.push(r.then((r) => handlePropertyResult(r, payload, key, input, optin, optout)));
		else handlePropertyResult(r, payload, key, input, optin, optout);
	}
	if (unrecognized.length) payload.issues.push({
		code: "unrecognized_keys",
		keys: unrecognized,
		input,
		inst,
		continue: true
	});
	if (!proms.length) return payload;
	return Promise.all(proms).then(() => {
		return payload;
	});
}
var $ZodObject = /*@__PURE__*/ $constructor("$ZodObject", (inst, def) => {
	$ZodType.init(inst, def);
	const desc = Object.getOwnPropertyDescriptor(def, "shape");
	const sh = desc?.get ? desc.get.raw : def.shape ?? {};
	if (sh) {
		const get = () => {
			const newSh = { ...sh };
			Object.defineProperty(def, "shape", { value: newSh });
			get.raw = newSh;
			return newSh;
		};
		get.raw = sh;
		Object.defineProperty(def, "shape", { get });
	}
	const _normalized = cached(() => normalizeDef(def));
	defineLazyInternal(inst, "propValues", (zod) => {
		const shape = zod.def.shape;
		const propValues = {};
		for (const key in shape) {
			const field = shape[key]._zod;
			if (field.values) {
				if (!Object.prototype.hasOwnProperty.call(propValues, key)) assignProp(propValues, key, /* @__PURE__ */ new Set());
				for (const v of field.values) propValues[key].add(v);
				if (field.optin !== void 0) propValues[key].add(void 0);
			}
		}
		return propValues;
	});
	const isObject$1 = isObject;
	const catchall = def.catchall;
	let value;
	const memo = globalConfig.memoizer;
	memo?.attach(inst);
	inst._zod.parse = (payload, ctx) => {
		value ?? (value = _normalized.value);
		const input = payload.value;
		if (!isObject$1(input)) {
			payload.issues.push({
				expected: "object",
				code: "invalid_type",
				input,
				inst
			});
			return payload;
		}
		payload.value = memo ? memo.alloc(inst, payload, {}, ctx) : {};
		const proms = [];
		const shape = value.shape;
		const abortEarly = ctx?.abortEarly;
		let seen = payload.issues.length;
		for (const key of value.allKeys) {
			if (abortEarly && payload.issues.length !== seen) {
				if (aborted(payload, seen)) break;
				seen = payload.issues.length;
			}
			if (key === "__proto__") continue;
			const el = shape[key];
			const optin = el._zod.optin;
			const optout = el._zod.optout;
			const r = el._zod.run({
				value: input[key],
				issues: []
			}, ctx);
			if (r instanceof Promise) proms.push(r.then((r) => handlePropertyResult(r, payload, key, input, optin, optout)));
			else handlePropertyResult(r, payload, key, input, optin, optout);
		}
		if (!catchall) return proms.length ? Promise.all(proms).then(() => payload) : payload;
		return handleCatchall(proms, input, payload, ctx, _normalized.value, inst, abortEarly === true);
	};
});
var $ZodObjectJIT = /*@__PURE__*/ $constructor("$ZodObjectJIT", (inst, def) => {
	$ZodObject.init(inst, def);
	const superParse = inst._zod.parse;
	const _normalized = cached(() => normalizeDef(def));
	const memo = globalConfig.memoizer;
	const generateFastpass = (shape) => {
		const normalized = _normalized.value;
		const syms = normalized.symbolKeys;
		const doc = new Doc(["payload", "ctx"], {
			shape,
			inst,
			memo,
			syms
		});
		const parseStr = (k) => `shape[${k}]._zod.run({ value: input[${k}], issues: [] }, ctx)`;
		const prefixStr = (id, k) => `
          let ${id}_ab = false;
          for (let i = 0; i < ${id}.issues.length; i++) {
            const iss = ${id}.issues[i];
            iss.path = iss.path ? [${k}, ...iss.path] : [${k}];
            payload.issues.push(iss);
            if (iss.continue !== true) ${id}_ab = true;
          }
          if (${id}_ab && ctx && ctx.abortEarly) {
            payload.value = newResult;
            return payload;
          }`;
		doc.write(`const input = payload.value;`);
		const ids = Object.create(null);
		let counter = 0;
		for (const key of normalized.allKeys) ids[key] = `key_${counter++}`;
		doc.write(memo ? `const newResult = memo.alloc(inst, payload, {}, ctx);` : `const newResult = {};`);
		for (const key of normalized.allKeys) {
			if (key === "__proto__") continue;
			const id = ids[key];
			const k = typeof key === "symbol" ? `syms[${syms.indexOf(key)}]` : esc(key);
			const isPresent = `${k} in input`;
			const schema = shape[key];
			const optin = schema?._zod?.optin;
			const isOptionalIn = optin !== void 0;
			const isOptionalOut = schema?._zod?.optout === "optional";
			doc.write(`const ${id} = ${parseStr(k)};`);
			if (isOptionalIn && isOptionalOut) {
				const assign = optin === "optional" ? `${id}_present` : `${id}.value !== undefined || ${id}_present`;
				doc.write(`
        const ${id}_present = ${isPresent};
        if (!${id}.issues.length || ${id}_present) {
          if (${id}.issues.length) {${prefixStr(id, k)}
          }

          if (${assign}) {
            newResult[${k}] = ${id}.value;
          }
        }

      `);
			} else if (!isOptionalIn) doc.write(`
        const ${id}_present = ${isPresent};
        if (${id}.issues.length) {${prefixStr(id, k)}
        }
        if (!${id}_present && !${id}.issues.length) {
          payload.issues.push({
            code: "invalid_type",
            expected: "nonoptional",
            input: undefined,
            path: [${k}]
          });
          if (ctx && ctx.abortEarly) {
            payload.value = newResult;
            return payload;
          }
        }

        if (${id}_present) {
          newResult[${k}] = ${id}.value;
        }

      `);
			else {
				doc.write(`
        if (${id}.issues.length) {${prefixStr(id, k)}
        }
      `);
				if (optin === "defaulted") doc.write(`newResult[${k}] = ${id}.value;`);
				else doc.write(`
        if (${id}.value !== undefined || ${isPresent}) {
          newResult[${k}] = ${id}.value;
        }
      `);
			}
		}
		doc.write(`payload.value = newResult;`);
		doc.write(`return payload;`);
		return doc.compile();
	};
	let fastpass;
	const isObject$2 = isObject;
	const jit = !globalConfig.jitless;
	const fastEnabled = jit && allowsEval.value;
	const catchall = def.catchall;
	let value;
	inst._zod.parse = (payload, ctx) => {
		value ?? (value = _normalized.value);
		const input = payload.value;
		if (!isObject$2(input)) {
			payload.issues.push({
				expected: "object",
				code: "invalid_type",
				input,
				inst
			});
			return payload;
		}
		if (jit && fastEnabled && ctx?.async === false && ctx.jitless !== true) {
			if (!fastpass) fastpass = generateFastpass(def.shape);
			payload = fastpass(payload, ctx);
			if (!catchall) return payload;
			return handleCatchall([], input, payload, ctx, value, inst, ctx?.abortEarly === true);
		}
		return superParse(payload, ctx);
	};
});
function handleUnionResults(results, final, inst, ctx) {
	for (const result of results) if (result.issues.length === 0) {
		final.value = result.value;
		return final;
	}
	const nonaborted = results.filter((r) => !aborted(r));
	if (nonaborted.length === 1) {
		final.value = nonaborted[0].value;
		return nonaborted[0];
	}
	final.issues.push({
		code: "invalid_union",
		input: final.value,
		inst,
		errors: results.map((result) => result.issues.map((iss) => finalizeIssue(iss, ctx, config())))
	});
	return final;
}
var $ZodUnion = /*@__PURE__*/ $constructor("$ZodUnion", (inst, def) => {
	$ZodType.init(inst, def);
	defineLazyInternal(inst, "optin", (zod) => zod.def.options.some((o) => o._zod.optin === "defaulted") ? "defaulted" : zod.def.options.some((o) => o._zod.optin !== void 0) ? "optional" : void 0);
	defineLazyInternal(inst, "optout", (zod) => zod.def.options.some((o) => o._zod.optout === "optional") ? "optional" : void 0);
	defineLazyInternal(inst, "values", (zod) => {
		if (zod.def.options.every((o) => o._zod.values)) return new Set(zod.def.options.flatMap((option) => Array.from(option._zod.values)));
	});
	defineLazyInternal(inst, "pattern", (zod) => {
		if (zod.def.options.every((o) => o._zod.pattern)) {
			const patterns = zod.def.options.map((o) => o._zod.pattern);
			return new RegExp(`^(${patterns.map((p) => cleanRegex(p.source)).join("|")})$`);
		}
	});
	const first = def.options.length === 1 ? def.options[0]._zod.run : null;
	inst._zod.parse = (payload, ctx) => {
		if (first) return first(payload, ctx);
		let async = false;
		const results = [];
		for (const option of def.options) {
			const result = option._zod.run({
				value: payload.value,
				issues: []
			}, ctx);
			if (result instanceof Promise) {
				results.push(result);
				async = true;
			} else {
				if (result.issues.length === 0) return result;
				results.push(result);
			}
		}
		if (!async) return handleUnionResults(results, payload, inst, ctx);
		return Promise.all(results).then((results) => {
			return handleUnionResults(results, payload, inst, ctx);
		});
	};
});
var $ZodIntersection = /*@__PURE__*/ $constructor("$ZodIntersection", (inst, def) => {
	$ZodType.init(inst, def);
	inst._zod.parse = (payload, ctx) => {
		const input = payload.value;
		const left = def.left._zod.run({
			value: input,
			issues: []
		}, ctx);
		const right = def.right._zod.run({
			value: input,
			issues: []
		}, ctx);
		if (left instanceof Promise || right instanceof Promise) return Promise.all([left, right]).then(([left, right]) => {
			return handleIntersectionResults(payload, left, right);
		});
		return handleIntersectionResults(payload, left, right);
	};
});
function mergeValues(a, b) {
	if (a === b) return {
		valid: true,
		data: a
	};
	if (a instanceof Date && b instanceof Date && +a === +b) return {
		valid: true,
		data: a
	};
	if (isPlainObject(a) && isPlainObject(b)) {
		const bKeys = Object.keys(b);
		const sharedKeys = Object.keys(a).filter((key) => bKeys.indexOf(key) !== -1);
		const newObj = {
			...a,
			...b
		};
		if (Object.prototype.hasOwnProperty.call(newObj, "__proto__")) delete newObj.__proto__;
		for (const key of sharedKeys) {
			if (key === "__proto__") continue;
			const sharedValue = mergeValues(a[key], b[key]);
			if (!sharedValue.valid) return {
				valid: false,
				mergeErrorPath: [key, ...sharedValue.mergeErrorPath]
			};
			newObj[key] = sharedValue.data;
		}
		return {
			valid: true,
			data: newObj
		};
	}
	if (Array.isArray(a) && Array.isArray(b)) {
		if (a.length !== b.length) return {
			valid: false,
			mergeErrorPath: []
		};
		const newArray = [];
		for (let index = 0; index < a.length; index++) {
			const itemA = a[index];
			const itemB = b[index];
			const sharedValue = mergeValues(itemA, itemB);
			if (!sharedValue.valid) return {
				valid: false,
				mergeErrorPath: [index, ...sharedValue.mergeErrorPath]
			};
			newArray.push(sharedValue.data);
		}
		return {
			valid: true,
			data: newArray
		};
	}
	return {
		valid: false,
		mergeErrorPath: []
	};
}
function handleIntersectionResults(result, left, right) {
	const unrecKeys = /* @__PURE__ */ new Map();
	let unrecIssue;
	const keyIssues = /* @__PURE__ */ new Map();
	const collect = (iss, side) => {
		let keys;
		if (iss.code === "unrecognized_keys" && !iss.path?.length) {
			unrecIssue ?? (unrecIssue = iss);
			keys = iss.keys;
		} else if (iss.code === "invalid_key" && iss.origin === "record" && iss.path?.length === 1) {
			const k = String(iss.path[0]);
			if (!keyIssues.has(k)) keyIssues.set(k, iss);
			keys = [k];
		} else return false;
		for (const k of keys) {
			if (!unrecKeys.has(k)) unrecKeys.set(k, {});
			unrecKeys.get(k)[side] = true;
		}
		return true;
	};
	for (const iss of left.issues) if (!collect(iss, "l")) result.issues.push(iss);
	for (const iss of right.issues) if (!collect(iss, "r")) result.issues.push(iss);
	const bothKeys = [...unrecKeys].filter(([, f]) => f.l && f.r).map(([k]) => k);
	if (bothKeys.length) {
		const aggregated = unrecIssue ? bothKeys.filter((k) => unrecIssue.keys.includes(k)) : [];
		if (aggregated.length) result.issues.push({
			...unrecIssue,
			keys: aggregated
		});
		for (const k of bothKeys) if (!aggregated.includes(k) && keyIssues.has(k)) result.issues.push(keyIssues.get(k));
	}
	const merged = mergeValues(left.value, right.value);
	if (!merged.valid) {
		if (aborted(result)) return result;
		throw new Error(`Unmergable intersection. Error path: ${JSON.stringify(merged.mergeErrorPath)}`);
	}
	result.value = merged.data;
	return result;
}
var $ZodRecord = /*@__PURE__*/ $constructor("$ZodRecord", (inst, def) => {
	$ZodType.init(inst, def);
	const memo = globalConfig.memoizer;
	memo?.attach(inst);
	inst._zod.parse = (payload, ctx) => {
		const input = payload.value;
		if (!isPlainObject(input)) {
			payload.issues.push({
				expected: "record",
				code: "invalid_type",
				input,
				inst
			});
			return payload;
		}
		const proms = [];
		const values = def.keyType._zod.values;
		if (values && !def.partial) {
			payload.value = memo ? memo.alloc(inst, payload, {}, ctx) : {};
			const recordKeys = /* @__PURE__ */ new Set();
			for (const key of values) if (typeof key === "string" || typeof key === "number" || typeof key === "symbol") {
				recordKeys.add(typeof key === "number" ? key.toString() : key);
				if (key === "__proto__") continue;
				const keyResult = def.keyType._zod.run({
					value: key,
					issues: []
				}, ctx);
				if (keyResult instanceof Promise) throw new Error("Async schemas not supported in object keys currently");
				if (keyResult.issues.length) {
					payload.issues.push({
						code: "invalid_key",
						origin: "record",
						issues: keyResult.issues.map((iss) => finalizeIssue(iss, ctx, config())),
						input: key,
						path: [key],
						inst
					});
					continue;
				}
				const outKey = keyResult.value;
				if (outKey === "__proto__") continue;
				const result = def.valueType._zod.run({
					value: input[key],
					issues: []
				}, ctx);
				if (result instanceof Promise) proms.push(result.then((result) => {
					if (result.issues.length) payload.issues.push(...prefixIssues(key, result.issues));
					payload.value[outKey] = result.value;
				}));
				else {
					if (result.issues.length) payload.issues.push(...prefixIssues(key, result.issues));
					payload.value[outKey] = result.value;
				}
			}
			let unrecognized;
			for (const key in input) if (!recordKeys.has(key)) {
				if (def.mode === "loose") {
					if (key === "__proto__") continue;
					payload.value[key] = input[key];
				} else {
					unrecognized = unrecognized ?? [];
					unrecognized.push(key);
				}
			}
			if (unrecognized && unrecognized.length > 0) payload.issues.push({
				code: "unrecognized_keys",
				input,
				inst,
				keys: unrecognized,
				continue: true
			});
		} else {
			payload.value = memo ? memo.alloc(inst, payload, {}, ctx) : {};
			let unrecognized;
			for (const key of Reflect.ownKeys(input)) {
				if (key === "__proto__") continue;
				if (!Object.prototype.propertyIsEnumerable.call(input, key)) continue;
				let keyResult = def.keyType._zod.run({
					value: key,
					issues: []
				}, ctx);
				if (keyResult instanceof Promise) throw new Error("Async schemas not supported in object keys currently");
				if (typeof key === "string" && number$1.test(key) && keyResult.issues.length) {
					const retryResult = def.keyType._zod.run({
						value: Number(key),
						issues: []
					}, ctx);
					if (retryResult instanceof Promise) throw new Error("Async schemas not supported in object keys currently");
					if (retryResult.issues.length === 0) keyResult = retryResult;
				}
				if (keyResult.issues.length) {
					if (def.mode === "loose") payload.value[key] = input[key];
					else if (values) {
						unrecognized = unrecognized ?? [];
						unrecognized.push(key);
					} else payload.issues.push({
						code: "invalid_key",
						origin: "record",
						issues: keyResult.issues.map((iss) => finalizeIssue(iss, ctx, config())),
						input: key,
						path: [key],
						inst
					});
					continue;
				}
				const outKey = keyResult.value;
				if (outKey === "__proto__") continue;
				const result = def.valueType._zod.run({
					value: input[key],
					issues: []
				}, ctx);
				if (result instanceof Promise) proms.push(result.then((result) => {
					if (result.issues.length) payload.issues.push(...prefixIssues(key, result.issues));
					payload.value[outKey] = result.value;
				}));
				else {
					if (result.issues.length) payload.issues.push(...prefixIssues(key, result.issues));
					payload.value[outKey] = result.value;
				}
			}
			if (unrecognized && unrecognized.length > 0) payload.issues.push({
				code: "unrecognized_keys",
				input,
				inst,
				keys: unrecognized,
				continue: true
			});
		}
		if (proms.length) return Promise.all(proms).then(() => payload);
		return payload;
	};
});
var $ZodEnum = /*@__PURE__*/ $constructor("$ZodEnum", (inst, def) => {
	$ZodType.init(inst, def);
	const values = getEnumValues(def.entries);
	const valuesSet = new Set(values);
	inst._zod.values = valuesSet;
	defineLazyInternal(inst, "pattern", (zod) => {
		const patternValues = getEnumValues(zod.def.entries).filter((k) => propertyKeyTypes.has(typeof k));
		return new RegExp(patternValues.length ? `^(${patternValues.map((o) => escapeRegex(o.toString())).join("|")})$` : "^[^\\s\\S]$");
	});
	inst._zod.parse = (payload, _ctx) => {
		const input = payload.value;
		if (valuesSet.has(input)) return payload;
		payload.issues.push({
			code: "invalid_value",
			values,
			input,
			inst
		});
		return payload;
	};
});
var $ZodTransform = /*@__PURE__*/ $constructor("$ZodTransform", (inst, def) => {
	$ZodType.init(inst, def);
	inst._zod.optin = "optional";
	globalConfig.memoizer?.guard(inst);
	inst._zod.parse = (payload, ctx) => {
		if (ctx.direction === "backward") throw new $ZodEncodeError(inst.constructor.name);
		const _out = def.transform(payload.value, payload);
		if (ctx.async) return (_out instanceof Promise ? _out : Promise.resolve(_out)).then((output) => {
			payload.value = output;
			return payload;
		});
		if (_out instanceof Promise) throw new $ZodAsyncError();
		payload.value = _out;
		return payload;
	};
});
function handleOptionalResult(payload, result) {
	payload.value = result.issues.length ? void 0 : result.value;
	return payload;
}
var $ZodOptional = /*@__PURE__*/ $constructor("$ZodOptional", (inst, def) => {
	$ZodType.init(inst, def);
	defineLazyInternal(inst, "optin", (zod) => zod.def.innerType._zod.optin === "defaulted" ? "defaulted" : "optional");
	inst._zod.optout = "optional";
	defineLazyInternal(inst, "values", (zod) => {
		const values = zod.def.innerType._zod.values;
		return values ? /* @__PURE__ */ new Set([...values, void 0]) : void 0;
	});
	defineLazyInternal(inst, "pattern", (zod) => {
		const pattern = zod.def.innerType._zod.pattern;
		return pattern ? new RegExp(`^(${cleanRegex(pattern.source)})?$`) : void 0;
	});
	inst._zod.parse = (payload, ctx) => {
		if (payload.value === void 0) {
			if (def.innerType._zod.optin !== "defaulted") return payload;
			const result = def.innerType._zod.run({
				value: payload.value,
				issues: []
			}, ctx);
			if (result instanceof Promise) return result.then((result) => handleOptionalResult(payload, result));
			return handleOptionalResult(payload, result);
		}
		return def.innerType._zod.run(payload, ctx);
	};
});
var $ZodExactOptional = /*@__PURE__*/ $constructor("$ZodExactOptional", (inst, def) => {
	$ZodOptional.init(inst, def);
	defineLazyInternal(inst, "values", (zod) => zod.def.innerType._zod.values);
	defineLazyInternal(inst, "pattern", (zod) => zod.def.innerType._zod.pattern);
	inst._zod.parse = (payload, ctx) => {
		return def.innerType._zod.run(payload, ctx);
	};
});
var $ZodNullable = /*@__PURE__*/ $constructor("$ZodNullable", (inst, def) => {
	$ZodType.init(inst, def);
	defineLazyInternal(inst, "optin", (zod) => zod.def.innerType._zod.optin);
	defineLazyInternal(inst, "optout", (zod) => zod.def.innerType._zod.optout);
	defineLazyInternal(inst, "pattern", (zod) => {
		const pattern = zod.def.innerType._zod.pattern;
		return pattern ? new RegExp(`^(${cleanRegex(pattern.source)}|null)$`) : void 0;
	});
	defineLazyInternal(inst, "values", (zod) => {
		return zod.def.innerType._zod.values ? /* @__PURE__ */ new Set([...zod.def.innerType._zod.values, null]) : void 0;
	});
	inst._zod.parse = (payload, ctx) => {
		if (payload.value === null) return payload;
		return def.innerType._zod.run(payload, ctx);
	};
});
var $ZodDefault = /*@__PURE__*/ $constructor("$ZodDefault", (inst, def) => {
	$ZodType.init(inst, def);
	inst._zod.optin = "defaulted";
	defineLazyInternal(inst, "values", (zod) => zod.def.innerType._zod.values);
	inst._zod.parse = (payload, ctx) => {
		if (ctx.direction === "backward") return def.innerType._zod.run(payload, ctx);
		if (payload.value === void 0) {
			payload.value = def.defaultValue;
			/**
			* $ZodDefault returns the default value immediately in forward direction.
			* It doesn't pass the default value into the validator ("prefault"). There's no reason to pass the default value through validation. The validity of the default is enforced by TypeScript statically. Otherwise, it's the responsibility of the user to ensure the default is valid. In the case of pipes with divergent in/out types, you can specify the default on the `in` schema of your ZodPipe to set a "prefault" for the pipe.   */
			return payload;
		}
		const result = def.innerType._zod.run(payload, ctx);
		if (result instanceof Promise) return result.then((result) => handleDefaultResult(result, def));
		return handleDefaultResult(result, def);
	};
});
function handleDefaultResult(payload, def) {
	if (payload.value === void 0) payload.value = def.defaultValue;
	return payload;
}
var $ZodPrefault = /*@__PURE__*/ $constructor("$ZodPrefault", (inst, def) => {
	$ZodType.init(inst, def);
	inst._zod.optin = "defaulted";
	defineLazyInternal(inst, "values", (zod) => zod.def.innerType._zod.values);
	inst._zod.parse = (payload, ctx) => {
		if (ctx.direction === "backward") return def.innerType._zod.run(payload, ctx);
		if (payload.value === void 0) payload.value = def.defaultValue;
		return def.innerType._zod.run(payload, ctx);
	};
});
var $ZodNonOptional = /*@__PURE__*/ $constructor("$ZodNonOptional", (inst, def) => {
	$ZodType.init(inst, def);
	defineLazyInternal(inst, "values", (zod) => {
		const v = zod.def.innerType._zod.values;
		return v ? new Set([...v].filter((x) => x !== void 0)) : void 0;
	});
	inst._zod.parse = (payload, ctx) => {
		const result = def.innerType._zod.run(payload, ctx);
		if (result instanceof Promise) return result.then((result) => handleNonOptionalResult(result, inst));
		return handleNonOptionalResult(result, inst);
	};
});
function handleNonOptionalResult(payload, inst) {
	if (!payload.issues.length && payload.value === void 0) payload.issues.push({
		code: "invalid_type",
		expected: "nonoptional",
		input: payload.value,
		inst
	});
	return payload;
}
function handleCatchResult(payload, result, def, ctx) {
	if (!result.issues.length) {
		payload.value = result.value;
		if (result.memo) payload.memo = true;
		return payload;
	}
	payload.value = def.catchValue({
		...result,
		value: payload.value,
		error: { issues: result.issues.map((iss) => finalizeIssue(iss, ctx, config())) },
		input: payload.value
	});
	return payload;
}
var $ZodCatch = /*@__PURE__*/ $constructor("$ZodCatch", (inst, def) => {
	$ZodType.init(inst, def);
	defineLazyInternal(inst, "optin", (zod) => zod.def.innerType._zod.optin === "defaulted" ? "defaulted" : "optional");
	defineLazyInternal(inst, "optout", (zod) => zod.def.innerType._zod.optout);
	defineLazyInternal(inst, "values", (zod) => zod.def.innerType._zod.values);
	inst._zod.parse = (payload, ctx) => {
		if (ctx.direction === "backward") return def.innerType._zod.run(payload, ctx);
		const result = def.innerType._zod.run({
			value: payload.value,
			issues: []
		}, ctx);
		if (result instanceof Promise) return result.then((result) => handleCatchResult(payload, result, def, ctx));
		return handleCatchResult(payload, result, def, ctx);
	};
});
var $ZodPipe = /*@__PURE__*/ $constructor("$ZodPipe", (inst, def) => {
	$ZodType.init(inst, def);
	defineLazyInternal(inst, "values", (zod) => zod.def.in._zod.values);
	defineLazyInternal(inst, "optin", (zod) => zod.def.in._zod.optin);
	defineLazyInternal(inst, "optout", (zod) => zod.def.out._zod.optout);
	defineLazyInternal(inst, "propValues", (zod) => zod.def.in._zod.propValues);
	inst._zod.parse = (payload, ctx) => {
		if (ctx.direction === "backward") {
			const right = def.out._zod.run(payload, ctx);
			if (right instanceof Promise) return right.then((right) => handlePipeResult(right, def.in, ctx));
			return handlePipeResult(right, def.in, ctx);
		}
		const left = def.in._zod.run(payload, ctx);
		if (left instanceof Promise) return left.then((left) => handlePipeResult(left, def.out, ctx));
		return handlePipeResult(left, def.out, ctx);
	};
});
function handlePipeResult(left, next, ctx) {
	if (left.issues.some((iss) => iss.code !== "unrecognized_keys")) {
		left.aborted = true;
		return left;
	}
	return next._zod.run({
		value: left.value,
		issues: left.issues
	}, ctx);
}
var $ZodReadonly = /*@__PURE__*/ $constructor("$ZodReadonly", (inst, def) => {
	$ZodType.init(inst, def);
	defineLazyInternal(inst, "propValues", (zod) => zod.def.innerType._zod.propValues);
	defineLazyInternal(inst, "values", (zod) => zod.def.innerType._zod.values);
	defineLazyInternal(inst, "optin", (zod) => zod.def.innerType?._zod?.optin);
	defineLazyInternal(inst, "optout", (zod) => zod.def.innerType?._zod?.optout);
	inst._zod.parse = (payload, ctx) => {
		if (ctx.direction === "backward") return def.innerType._zod.run(payload, ctx);
		const result = def.innerType._zod.run(payload, ctx);
		if (result instanceof Promise) return result.then(handleReadonlyResult);
		return handleReadonlyResult(result);
	};
});
function handleReadonlyResult(payload) {
	if (!payload.memo) payload.value = Object.freeze(payload.value);
	return payload;
}
var $ZodCustom = /*@__PURE__*/ $constructor("$ZodCustom", (inst, def) => {
	$ZodCheck.init(inst, def);
	$ZodType.init(inst, def);
	inst._zod.parse = (payload, _) => {
		return payload;
	};
	inst._zod.check = (payload) => {
		const input = payload.value;
		const r = def.fn(input);
		if (r instanceof Promise) return r.then((r) => handleRefineResult(r, payload, input, inst));
		handleRefineResult(r, payload, input, inst);
	};
});
function handleRefineResult(result, payload, input, inst) {
	if (!result) {
		const _iss = {
			code: "custom",
			input,
			inst,
			path: [...inst._zod.def.path ?? []],
			continue: !inst._zod.def.abort
		};
		if (inst._zod.def.params) _iss.params = inst._zod.def.params;
		payload.issues.push(issue(_iss));
	}
}
// ../../node_modules/.bun/zod@4.6.7/node_modules/zod/v4/core/memoizer.js
var $ZodCyclicError = class extends Error {
	constructor() {
		super(`Cannot parse a reference cycle that closes through a transform`);
		this.name = "ZodCyclicError";
	}
};
/** Keyed off the context object every schema in one parse call already shares. */
var STATE = "~memo";
var NO_ISSUES = [];
function isRef(value) {
	return value !== null && typeof value === "object";
}
function cloneIssues(issues) {
	return issues.map((iss) => iss.path ? {
		...iss,
		path: iss.path.slice()
	} : { ...iss });
}
var recursive = /*@__PURE__*/ new WeakMap();
/** What the walk established, in order of certainty: ordered so the strongest answer among children wins. */
var NONE = 0;
var ASSUMED = 1;
var PROVEN = 2;
/** Whether this schema's subtree contains a cycle, so one parse can re-enter it. */
function isRecursive(inst, stack, resolve) {
	const cached = recursive.get(inst);
	if (cached !== void 0) return cached ? PROVEN : NONE;
	if (stack.has(inst)) return PROVEN;
	stack.add(inst);
	let result = NONE;
	const check = (child) => {
		if (result !== PROVEN && child?._zod) {
			const answer = isRecursive(child, stack, resolve);
			if (answer > result) result = answer;
		}
	};
	const shape = (sh, spread) => {
		let answer = NONE;
		for (const key of Reflect.ownKeys(sh)) {
			const desc = Object.getOwnPropertyDescriptor(sh, key);
			if (spread && !desc.enumerable) continue;
			const child = desc.get ? ASSUMED : desc.value?._zod ? isRecursive(desc.value, stack, resolve) : NONE;
			if (child > answer) answer = child;
		}
		return answer;
	};
	const merge = (answer) => {
		if (answer > result) result = answer;
	};
	const def = inst._zod.def;
	switch (def.type) {
		case "object": {
			const raw = rawShape(def);
			merge(raw ? shape(raw, true) : ASSUMED);
			check(def.catchall);
			break;
		}
		case "array":
			check(def.element);
			break;
		case "tuple":
			for (const el of def.items) check(el);
			check(def.rest);
			break;
		case "record":
		case "map":
			check(def.keyType);
			check(def.valueType);
			break;
		case "set":
			check(def.valueType);
			break;
		case "union":
			for (const el of def.options) check(el);
			break;
		case "intersection":
			check(def.left);
			check(def.right);
			break;
		case "optional":
		case "nullable":
		case "default":
		case "prefault":
		case "catch":
		case "readonly":
		case "nonoptional":
		case "promise":
		case "success":
			check(def.innerType);
			break;
		case "pipe":
			check(def.in);
			check(def.out);
			break;
		case "function":
			check(def.input);
			check(def.output);
			break;
		case "lazy": {
			const inner = def._cachedInner ?? (resolve ? inst._zod.innerType : void 0);
			merge(inner ? isRecursive(inner, stack, false) : ASSUMED);
			break;
		}
		case "template_literal":
		case "string":
		case "number":
		case "int":
		case "boolean":
		case "bigint":
		case "symbol":
		case "undefined":
		case "null":
		case "void":
		case "never":
		case "any":
		case "unknown":
		case "date":
		case "nan":
		case "enum":
		case "literal":
		case "file":
		case "transform":
		case "custom": break;
		default: for (const key in def) {
			const desc = Object.getOwnPropertyDescriptor(def, key);
			if (!desc || desc.get) continue;
			const value = desc.value;
			if (!value || typeof value !== "object") continue;
			if (value._zod) check(value);
			else if (Array.isArray(value)) for (const el of value) check(el);
		}
	}
	stack.delete(inst);
	return settle$1(inst, result);
}
/** An assumed answer must not outlive the resolution that settles it, so only a certain one is cached. */
function settle$1(inst, answer) {
	if (answer !== ASSUMED) recursive.set(inst, answer === PROVEN);
	return answer;
}
function bucketFor(state, inst) {
	let bucket = state.buckets.get(inst);
	if (!bucket) {
		bucket = /* @__PURE__ */ new WeakMap();
		state.buckets.set(inst, bucket);
	}
	return bucket;
}
var handoff;
var open = [];
var memo = {
	alloc(_inst, payload, empty) {
		const bucket = handoff;
		if (!bucket) return empty;
		handoff = void 0;
		const entry = {
			value: empty,
			issues: null
		};
		bucket.set(payload.value, entry);
		open.push(entry);
		return empty;
	},
	guard(inst) {
		var _a;
		(_a = inst._zod).deferred ?? (_a.deferred = []);
		inst._zod.deferred.push(() => {
			const base = inst._zod.parse;
			const wrapped = (payload, ctx) => {
				if (ctx.direction !== "backward" && isBackEdge(ctx, payload.value)) throw new $ZodCyclicError();
				return base(payload, ctx);
			};
			inst._zod.parse = wrapped;
			if (inst._zod.run === base) inst._zod.run = wrapped;
		});
	},
	attach(inst) {
		var _a;
		let isRecursiveInst;
		let rechecked = false;
		let lastCtx;
		let lastBucket;
		(_a = inst._zod).deferred ?? (_a.deferred = []);
		inst._zod.deferred.push(() => {
			const base = inst._zod.parse;
			const wrapped = (payload, ctx) => {
				if (isRecursiveInst === void 0) {
					const walked = isRecursive(inst, /* @__PURE__ */ new Set(), false);
					if (walked === NONE) {
						inst._zod.parse = base;
						if (inst._zod.run === wrapped) inst._zod.run = base;
						return base(payload, ctx);
					}
					if (walked === PROVEN || rechecked) isRecursiveInst = true;
					else rechecked = true;
				}
				const input = payload.value;
				if (!isRef(input)) return base(payload, ctx);
				let state = ctx[STATE];
				if (!state) {
					state = {
						buckets: /* @__PURE__ */ new WeakMap(),
						backEdges: void 0
					};
					ctx[STATE] = state;
				}
				let bucket;
				if (lastCtx === ctx) bucket = lastBucket;
				else {
					bucket = bucketFor(state, inst);
					lastCtx = ctx;
					lastBucket = bucket;
				}
				const hit = bucket.get(input);
				if (hit) {
					payload.value = hit.value;
					if (hit.issues) {
						if (hit.issues.length) payload.issues.push(...cloneIssues(hit.issues));
					} else {
						payload.memo = true;
						state.backEdges ?? (state.backEdges = /* @__PURE__ */ new WeakSet());
						state.backEdges.add(hit.value);
					}
					return payload;
				}
				handoff = bucket;
				const depth = open.length;
				const result = base(payload, ctx);
				handoff = void 0;
				const entry = open.length > depth ? open.pop() : void 0;
				if (result instanceof Promise) return result.then((r) => {
					if (entry) entry.issues = r.issues.length ? cloneIssues(r.issues) : NO_ISSUES;
					return r;
				});
				if (entry) entry.issues = result.issues.length ? cloneIssues(result.issues) : NO_ISSUES;
				return result;
			};
			inst._zod.parse = wrapped;
			if (inst._zod.run === base) inst._zod.run = wrapped;
		});
	}
};
/** The memoizer that gives containers cycle support. `zod` installs it by default; `zod/mini` opts in with `config({ memoizer: memoizer() })`. */
function memoizer() {
	return memo;
}
/** Whether this value is a node a back-edge resolved to before it finished. */
function isBackEdge(ctx, value) {
	const backEdges = ctx[STATE]?.backEdges;
	return backEdges !== void 0 && isRef(value) && backEdges.has(value);
}
// ../../node_modules/.bun/zod@4.6.7/node_modules/zod/v4/locales/en.js
var error = () => {
	const Sizable = {
		string: {
			unit: "characters",
			verb: "to have"
		},
		file: {
			unit: "bytes",
			verb: "to have"
		},
		array: {
			unit: "items",
			verb: "to have"
		},
		set: {
			unit: "items",
			verb: "to have"
		},
		map: {
			unit: "entries",
			verb: "to have"
		}
	};
	function getSizing(origin) {
		return Sizable[origin] ?? null;
	}
	const FormatDictionary = {
		regex: "input",
		email: "email address",
		url: "URL",
		emoji: "emoji",
		uuid: "UUID",
		uuidv4: "UUIDv4",
		uuidv6: "UUIDv6",
		nanoid: "nanoid",
		guid: "GUID",
		cuid: "cuid",
		cuid2: "cuid2",
		ulid: "ULID",
		xid: "XID",
		ksuid: "KSUID",
		datetime: "ISO datetime",
		date: "ISO date",
		time: "ISO time",
		duration: "ISO duration",
		ipv4: "IPv4 address",
		ipv6: "IPv6 address",
		mac: "MAC address",
		cidrv4: "IPv4 range",
		cidrv6: "IPv6 range",
		base64: "base64-encoded string",
		base64url: "base64url-encoded string",
		json_string: "JSON string",
		e164: "E.164 number",
		currency_code: "currency code",
		credit_card: "credit card number",
		iban: "IBAN",
		jwt: "JWT",
		template_literal: "input"
	};
	const TypeDictionary = { nan: "NaN" };
	function getTypeName(type, input) {
		if (type === "number" && typeof input === "number" && !Number.isFinite(input)) return String(input);
		return TypeDictionary[type] ?? type;
	}
	return (issue) => {
		switch (issue.code) {
			case "invalid_type": return `Invalid input: expected ${getTypeName(issue.expected)}, received ${getTypeName(parsedType(issue.input), issue.input)}`;
			case "invalid_value":
				if (issue.values.length === 1) return `Invalid input: expected ${stringifyPrimitive(issue.values[0])}`;
				return `Invalid option: expected one of ${joinValues(issue.values, "|")}`;
			case "too_big": {
				const adj = issue.exact ? "exactly " : issue.inclusive ? "<=" : "<";
				const sizing = getSizing(issue.origin);
				if (sizing) return `Too big: expected ${issue.origin ?? "value"} to have ${adj}${issue.maximum.toString()} ${sizing.unit ?? "elements"}`;
				return `Too big: expected ${issue.origin ?? "value"} to be ${adj}${issue.maximum.toString()}`;
			}
			case "too_small": {
				const adj = issue.exact ? "exactly " : issue.inclusive ? ">=" : ">";
				const sizing = getSizing(issue.origin);
				if (sizing) return `Too small: expected ${issue.origin} to have ${adj}${issue.minimum.toString()} ${sizing.unit}`;
				return `Too small: expected ${issue.origin} to be ${adj}${issue.minimum.toString()}`;
			}
			case "invalid_format": {
				const _issue = issue;
				if (_issue.format === "starts_with") return `Invalid string: must start with "${_issue.prefix}"`;
				if (_issue.format === "ends_with") return `Invalid string: must end with "${_issue.suffix}"`;
				if (_issue.format === "includes") return `Invalid string: must include "${_issue.includes}"`;
				if (_issue.format === "regex") return `Invalid string: must match pattern ${_issue.pattern}`;
				return `Invalid ${FormatDictionary[_issue.format] ?? issue.format}`;
			}
			case "not_multiple_of": return `Invalid number: must be a multiple of ${issue.divisor}`;
			case "unrecognized_keys": return `Unrecognized key${issue.keys.length > 1 ? "s" : ""}: ${joinValues(issue.keys, ", ")}`;
			case "invalid_key": return `Invalid key in ${issue.origin}`;
			case "invalid_union":
				if (issue.options && Array.isArray(issue.options) && issue.options.length > 0) return `Invalid discriminator value. Expected ${issue.options.map((o) => `'${o}'`).join(" | ")}`;
				if (issue.inclusive === false) return "Invalid input: more than one option matched";
				return "Invalid input";
			case "invalid_element": return `Invalid value in ${issue.origin}`;
			default: return `Invalid input`;
		}
	};
};
function en_default() {
	return { localeError: error() };
}
// ../../node_modules/.bun/zod@4.6.7/node_modules/zod/v4/core/registries.js
var _a;
var $ZodRegistry = class {
	constructor() {
		this._map = /* @__PURE__ */ new WeakMap();
		this._idmap = /* @__PURE__ */ new Map();
	}
	add(schema, ..._meta) {
		const meta = _meta[0];
		this._map.set(schema, meta);
		if (meta && typeof meta === "object" && "id" in meta) this._idmap.set(meta.id, schema);
		return this;
	}
	clear() {
		this._map = /* @__PURE__ */ new WeakMap();
		this._idmap = /* @__PURE__ */ new Map();
		return this;
	}
	remove(schema) {
		const meta = this._map.get(schema);
		if (meta && typeof meta === "object" && "id" in meta) this._idmap.delete(meta.id);
		this._map.delete(schema);
		return this;
	}
	get(schema) {
		const p = schema._zod.parent;
		if (p) {
			const pm = { ...this.get(p) ?? {} };
			delete pm.id;
			const f = {
				...pm,
				...this._map.get(schema)
			};
			return Object.keys(f).length ? f : void 0;
		}
		return this._map.get(schema);
	}
	has(schema) {
		return this._map.has(schema);
	}
};
function registry() {
	return new $ZodRegistry();
}
(_a = globalThis).__zod_globalRegistry ?? (_a.__zod_globalRegistry = registry());
var globalRegistry = globalThis.__zod_globalRegistry;
// ../../node_modules/.bun/zod@4.6.7/node_modules/zod/v4/core/api.js
function snapshotChecks(def) {
	if (def.checks) def.checks = [...def.checks];
	return def;
}
// @__NO_SIDE_EFFECTS__
function _string(Class, params) {
	return new Class(snapshotChecks({
		type: "string",
		...normalizeParams(params)
	}));
}
// @__NO_SIDE_EFFECTS__
function _email(Class, params) {
	return new Class({
		type: "string",
		format: "email",
		check: "string_format",
		abort: false,
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _guid(Class, params) {
	return new Class({
		type: "string",
		format: "guid",
		check: "string_format",
		abort: false,
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _uuid(Class, params) {
	return new Class({
		type: "string",
		format: "uuid",
		check: "string_format",
		abort: false,
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _uuidv4(Class, params) {
	return new Class({
		type: "string",
		format: "uuid",
		check: "string_format",
		abort: false,
		version: "v4",
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _uuidv6(Class, params) {
	return new Class({
		type: "string",
		format: "uuid",
		check: "string_format",
		abort: false,
		version: "v6",
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _uuidv7(Class, params) {
	return new Class({
		type: "string",
		format: "uuid",
		check: "string_format",
		abort: false,
		version: "v7",
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _url(Class, params) {
	return new Class({
		type: "string",
		format: "url",
		check: "string_format",
		abort: false,
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _emoji(Class, params) {
	return new Class({
		type: "string",
		format: "emoji",
		check: "string_format",
		abort: false,
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _nanoid(Class, params) {
	return new Class({
		type: "string",
		format: "nanoid",
		check: "string_format",
		abort: false,
		...normalizeParams(params)
	});
}
/**
* @deprecated CUID v1 is deprecated by its authors due to information leakage
* (timestamps embedded in the id). Use {@link _cuid2} instead.
* See https://github.com/paralleldrive/cuid.
*/
// @__NO_SIDE_EFFECTS__
function _cuid(Class, params) {
	return new Class({
		type: "string",
		format: "cuid",
		check: "string_format",
		abort: false,
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _cuid2(Class, params) {
	return new Class({
		type: "string",
		format: "cuid2",
		check: "string_format",
		abort: false,
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _ulid(Class, params) {
	return new Class({
		type: "string",
		format: "ulid",
		check: "string_format",
		abort: false,
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _xid(Class, params) {
	return new Class({
		type: "string",
		format: "xid",
		check: "string_format",
		abort: false,
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _ksuid(Class, params) {
	return new Class({
		type: "string",
		format: "ksuid",
		check: "string_format",
		abort: false,
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _ipv4(Class, params) {
	return new Class({
		type: "string",
		format: "ipv4",
		check: "string_format",
		abort: false,
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _ipv6(Class, params) {
	return new Class({
		type: "string",
		format: "ipv6",
		check: "string_format",
		abort: false,
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _cidrv4(Class, params) {
	return new Class({
		type: "string",
		format: "cidrv4",
		check: "string_format",
		abort: false,
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _cidrv6(Class, params) {
	return new Class({
		type: "string",
		format: "cidrv6",
		check: "string_format",
		abort: false,
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _base64(Class, params) {
	return new Class({
		type: "string",
		format: "base64",
		check: "string_format",
		abort: false,
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _base64url(Class, params) {
	return new Class({
		type: "string",
		format: "base64url",
		check: "string_format",
		abort: false,
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _e164(Class, params) {
	return new Class({
		type: "string",
		format: "e164",
		check: "string_format",
		abort: false,
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _jwt(Class, params) {
	return new Class({
		type: "string",
		format: "jwt",
		check: "string_format",
		abort: false,
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _isoDateTime(Class, params) {
	return new Class({
		type: "string",
		format: "datetime",
		check: "string_format",
		offset: false,
		local: false,
		precision: null,
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _isoDate(Class, params) {
	return new Class({
		type: "string",
		format: "date",
		check: "string_format",
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _isoTime(Class, params) {
	return new Class({
		type: "string",
		format: "time",
		check: "string_format",
		precision: null,
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _isoDuration(Class, params) {
	return new Class({
		type: "string",
		format: "duration",
		check: "string_format",
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _number(Class, params) {
	return new Class(snapshotChecks({
		type: "number",
		checks: [],
		...normalizeParams(params)
	}));
}
// @__NO_SIDE_EFFECTS__
function _int(Class, params) {
	return new Class({
		type: "number",
		check: "number_format",
		abort: false,
		format: "safeint",
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _boolean(Class, params) {
	return new Class({
		type: "boolean",
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _unknown(Class) {
	return new Class({ type: "unknown" });
}
// @__NO_SIDE_EFFECTS__
function _never(Class, params) {
	return new Class({
		type: "never",
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _lt(value, params) {
	return new $ZodCheckLessThan({
		check: "less_than",
		...normalizeParams(params),
		value,
		inclusive: false
	});
}
// @__NO_SIDE_EFFECTS__
function _lte(value, params) {
	return new $ZodCheckLessThan({
		check: "less_than",
		...normalizeParams(params),
		value,
		inclusive: true
	});
}
// @__NO_SIDE_EFFECTS__
function _gt(value, params) {
	return new $ZodCheckGreaterThan({
		check: "greater_than",
		...normalizeParams(params),
		value,
		inclusive: false
	});
}
// @__NO_SIDE_EFFECTS__
function _gte(value, params) {
	return new $ZodCheckGreaterThan({
		check: "greater_than",
		...normalizeParams(params),
		value,
		inclusive: true
	});
}
// @__NO_SIDE_EFFECTS__
function _multipleOf(value, params) {
	return new $ZodCheckMultipleOf({
		check: "multiple_of",
		...normalizeParams(params),
		value
	});
}
// @__NO_SIDE_EFFECTS__
function _maxLength(maximum, params) {
	return new $ZodCheckMaxLength({
		check: "max_length",
		...normalizeParams(params),
		maximum
	});
}
// @__NO_SIDE_EFFECTS__
function _minLength(minimum, params) {
	return new $ZodCheckMinLength({
		check: "min_length",
		...normalizeParams(params),
		minimum
	});
}
// @__NO_SIDE_EFFECTS__
function _length(length, params) {
	return new $ZodCheckLengthEquals({
		check: "length_equals",
		...normalizeParams(params),
		length
	});
}
// @__NO_SIDE_EFFECTS__
function _regex(pattern, params) {
	return new $ZodCheckRegex({
		check: "string_format",
		format: "regex",
		...normalizeParams(params),
		pattern
	});
}
// @__NO_SIDE_EFFECTS__
function _lowercase(params) {
	return new $ZodCheckLowerCase({
		check: "string_format",
		format: "lowercase",
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _uppercase(params) {
	return new $ZodCheckUpperCase({
		check: "string_format",
		format: "uppercase",
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _includes(includes, params) {
	return new $ZodCheckIncludes({
		check: "string_format",
		format: "includes",
		...normalizeParams(params),
		includes
	});
}
// @__NO_SIDE_EFFECTS__
function _startsWith(prefix, params) {
	return new $ZodCheckStartsWith({
		check: "string_format",
		format: "starts_with",
		...normalizeParams(params),
		prefix
	});
}
// @__NO_SIDE_EFFECTS__
function _endsWith(suffix, params) {
	return new $ZodCheckEndsWith({
		check: "string_format",
		format: "ends_with",
		...normalizeParams(params),
		suffix
	});
}
// @__NO_SIDE_EFFECTS__
function _overwrite(tx) {
	return new $ZodCheckOverwrite({
		check: "overwrite",
		tx
	});
}
// @__NO_SIDE_EFFECTS__
function _normalize(form) {
	return /* @__PURE__ */ _overwrite((input) => input.normalize(form));
}
// @__NO_SIDE_EFFECTS__
function _trim() {
	return /* @__PURE__ */ _overwrite((input) => input.trim());
}
// @__NO_SIDE_EFFECTS__
function _toLowerCase() {
	return /* @__PURE__ */ _overwrite((input) => input.toLowerCase());
}
// @__NO_SIDE_EFFECTS__
function _toUpperCase() {
	return /* @__PURE__ */ _overwrite((input) => input.toUpperCase());
}
// @__NO_SIDE_EFFECTS__
function _slugify() {
	return /* @__PURE__ */ _overwrite((input) => slugify(input));
}
// @__NO_SIDE_EFFECTS__
function _array(Class, element, params) {
	return new Class({
		type: "array",
		element,
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _refine(Class, fn, _params) {
	return new Class({
		type: "custom",
		check: "custom",
		fn,
		...normalizeParams(_params)
	});
}
// @__NO_SIDE_EFFECTS__
function _superRefine(fn, params) {
	const ch = /* @__PURE__ */ _check((payload) => {
		payload.addIssue = (issue$2) => {
			if (typeof issue$2 === "string") payload.issues.push(issue(issue$2, payload.value, ch._zod.def));
			else {
				const _issue = issue$2;
				if (_issue.fatal) _issue.continue = false;
				_issue.code ?? (_issue.code = "custom");
				if (!("input" in _issue)) _issue.input = payload.value;
				_issue.inst ?? (_issue.inst = ch);
				_issue.continue ?? (_issue.continue = !ch._zod.def.abort);
				payload.issues.push(issue(_issue));
			}
		};
		return fn(payload.value, payload);
	}, params);
	return ch;
}
// @__NO_SIDE_EFFECTS__
function _check(fn, params) {
	const ch = new $ZodCheck({
		check: "custom",
		...normalizeParams(params)
	});
	ch._zod.check = fn;
	return ch;
}
// ../../node_modules/.bun/zod@4.6.7/node_modules/zod/v4/core/to-json-schema.js
function assignProps(target, ...sources) {
	for (const source of sources) for (const key of Reflect.ownKeys(source)) if (Object.prototype.propertyIsEnumerable.call(source, key)) assignProp(target, key, source[key]);
	return target;
}
function initializeContext(params) {
	let target = params?.target ?? "draft-2020-12";
	if (target === "draft-4") target = "draft-04";
	if (target === "draft-7") target = "draft-07";
	return {
		processors: params.processors ?? {},
		metadataRegistry: params?.metadata ?? globalRegistry,
		target,
		unrepresentable: params?.unrepresentable ?? "throw",
		override: params?.override ?? (() => {}),
		io: params?.io ?? "output",
		counter: 0,
		seen: /* @__PURE__ */ new Map(),
		sharedDefsExtractedFor: void 0,
		sharedEmitDoneFor: void 0,
		cycles: params?.cycles ?? "ref",
		reused: params?.reused ?? "inline",
		intersections: [],
		deferred: [],
		external: params?.external ?? void 0
	};
}
/**
* Applies the `unrepresentable` setting at a site that has no JSON Schema equivalent. Throws
* `message` unless the setting (or the handler's return value) says otherwise. Returns `true` if a
* custom JSON Schema was written into `json`, in which case the caller must not write its own.
*/
function handleUnrepresentable(schema, ctx, json, params, message) {
	const result = typeof ctx.unrepresentable === "function" ? ctx.unrepresentable({
		zodSchema: schema,
		path: params.path,
		message
	}) : ctx.unrepresentable;
	if (result === "any") return false;
	if (result === void 0 || result === "throw") throw new Error(message);
	Object.assign(json, result);
	return true;
}
function processSchema(schema, ctx, _params = {
	path: [],
	schemaPath: []
}) {
	var _a;
	const def = schema._zod.def;
	const seen = ctx.seen.get(schema);
	if (seen) {
		seen.count++;
		if (_params.schemaPath.includes(schema)) seen.cycle = _params.path;
		return seen.schema;
	}
	const result = {
		schema: {},
		count: 1,
		cycle: void 0,
		path: _params.path
	};
	ctx.seen.set(schema, result);
	ctx.sharedDefsExtractedFor = void 0;
	ctx.sharedEmitDoneFor = void 0;
	const overrideSchema = schema._zod.toJSONSchema?.();
	if (overrideSchema) result.schema = overrideSchema;
	else {
		const params = {
			..._params,
			schemaPath: [..._params.schemaPath, schema],
			path: _params.path
		};
		if (schema._zod.processJSONSchema) schema._zod.processJSONSchema(ctx, result.schema, params);
		else {
			const _json = result.schema;
			const processor = ctx.processors[def.type];
			if (!processor) throw new Error(`[toJSONSchema]: Non-representable type encountered: ${def.type}`);
			processor(schema, ctx, _json, params);
		}
		const parent = schema._zod.parent;
		if (parent) {
			if (!result.ref) result.ref = parent;
			processSchema(parent, ctx, params);
			ctx.seen.get(parent).isParent = true;
		}
	}
	const meta = ctx.metadataRegistry.get(schema);
	if (meta) assignProps(result.schema, meta);
	if (ctx.io === "input" && isTransforming(schema)) {
		delete result.schema.examples;
		delete result.schema.default;
	}
	if (ctx.io === "input" && "_prefault" in result.schema) (_a = result.schema).default ?? (_a.default = result.schema._prefault);
	delete result.schema._prefault;
	return ctx.seen.get(schema).schema;
}
function encodeJSONPointerSegment(segment) {
	return segment.replace(/~/g, "~0").replace(/\//g, "~1");
}
function extractDefs(ctx, schema) {
	const root = ctx.seen.get(schema);
	if (!root) throw new Error("Unprocessed schema. This is a bug in Zod.");
	if (ctx.external && ctx.sharedDefsExtractedFor === ctx.external) return;
	const idToSchema = /* @__PURE__ */ new Map();
	for (const entry of ctx.seen.entries()) {
		const id = ctx.metadataRegistry.get(entry[0])?.id;
		if (id) {
			const existing = idToSchema.get(id);
			if (existing && existing !== entry[0]) throw new Error(`Duplicate schema id "${id}" detected during JSON Schema conversion. Two different schemas cannot share the same id when converted together.`);
			idToSchema.set(id, entry[0]);
		}
	}
	const makeURI = (entry) => {
		const defsSegment = ctx.target === "draft-2020-12" ? "$defs" : "definitions";
		if (ctx.external) {
			const externalId = ctx.external.registry.get(entry[0])?.id;
			const uriGenerator = ctx.external.uri ?? ((id) => id);
			if (externalId) return { ref: uriGenerator(externalId) };
			const id = entry[1].defId ?? entry[1].schema.id ?? `schema${ctx.counter++}`;
			entry[1].defId = id;
			return {
				defId: id,
				ref: `${uriGenerator("__shared")}#/${defsSegment}/${encodeJSONPointerSegment(id)}`
			};
		}
		const uriPrefix = `#`;
		const defUriPrefix = `${uriPrefix}/${defsSegment}/`;
		if (entry[1] === root && !entry[1].schema.id) return { ref: uriPrefix };
		const defId = entry[1].schema.id ?? `__schema${ctx.counter++}`;
		return {
			defId,
			ref: defUriPrefix + encodeJSONPointerSegment(defId)
		};
	};
	const extractToDef = (entry) => {
		if (entry[1].schema.$ref) return;
		const seen = entry[1];
		const { ref, defId } = makeURI(entry);
		seen.def = { ...seen.schema };
		if (defId) seen.defId = defId;
		const schema = seen.schema;
		for (const key in schema) delete schema[key];
		schema.$ref = ref;
	};
	if (ctx.cycles === "throw") for (const entry of ctx.seen.entries()) {
		const seen = entry[1];
		if (seen.cycle) throw new Error(`Cycle detected: #/${seen.cycle?.join("/")}/<root>

Set the \`cycles\` parameter to \`"ref"\` to resolve cyclical schemas with defs.`);
	}
	for (const entry of ctx.seen.entries()) {
		const seen = entry[1];
		if (schema === entry[0]) {
			extractToDef(entry);
			continue;
		}
		if (ctx.external) {
			const ext = ctx.external.registry.get(entry[0])?.id;
			if (schema !== entry[0] && ext) {
				extractToDef(entry);
				continue;
			}
		}
		if (ctx.metadataRegistry.get(entry[0])?.id) {
			extractToDef(entry);
			continue;
		}
		if (seen.cycle) {
			extractToDef(entry);
			continue;
		}
		if (seen.count > 1) {
			if (ctx.reused === "ref") extractToDef(entry);
		}
	}
	if (ctx.external) ctx.sharedDefsExtractedFor = ctx.external;
}
/** Rewrites `anyOf: [{type: "a"}, {type: "b"}]` to `type: ["a", "b"]`, which every JSON Schema draft treats as equivalent and most consumers render far better for the nullable case. Only branches that are a bare type assertion qualify — anything carrying a constraint, `$ref`, `const` or metadata is left alone. Runs after `flattenRef`, so a branch an override decorated or `$defs` extraction turned into a `$ref` is no longer bare and correctly stays in `anyOf`. `oneOf` is excluded: `integer` and `number` overlap, so "exactly one" and "at least one" are not the same there. OpenAPI 3.0 is excluded: its `type` must be a single string. */
function compactTypeUnion(schema) {
	const options = schema.anyOf;
	if (!Array.isArray(options) || options.length === 0 || schema.type !== void 0) return;
	const types = [];
	for (const option of options) {
		if (!option || typeof option !== "object") return;
		compactTypeUnion(option);
		const keys = Object.keys(option);
		if (keys.length !== 1 || keys[0] !== "type") return;
		const type = option.type;
		for (const member of Array.isArray(type) ? type : [type]) {
			if (typeof member !== "string") return;
			if (!types.includes(member)) types.push(member);
		}
	}
	delete schema.anyOf;
	schema.type = types.length === 1 ? types[0] : types;
}
/** Keywords `foldIntersection` knows how to combine. Anything else — `$ref`, `patternProperties`,
* an annotation like `description` — makes a member unfoldable, so a constraint this does not
* understand leaves the `allOf` alone instead of being silently dropped or misattributed. */
var FOLDABLE_KEYS = /* @__PURE__ */ new Set([
	"type",
	"properties",
	"required",
	"additionalProperties"
]);
var UNION_KEYS = ["oneOf", "anyOf"];
/** A member's constraint on a key it does not declare itself. A `catchall` states one; `false`, an absent `additionalProperties`, and the empty schema a loose object emits state nothing. */
function undeclaredConstraint(member) {
	const extra = member.additionalProperties;
	if (extra === void 0 || extra === false || typeof extra !== "object" || extra === null) return null;
	return Object.keys(extra).length ? extra : null;
}
/** Combines object members into the single object they describe together, or returns `null` if any of them carries a keyword outside {@link FOLDABLE_KEYS}. */
function foldObjects(members) {
	const objects = [];
	for (const member of members) {
		if (typeof member !== "object" || member.type !== "object") return null;
		for (const key in member) if (!FOLDABLE_KEYS.has(key)) return null;
		objects.push(member);
	}
	const properties = {};
	const required = /* @__PURE__ */ new Set();
	for (const object of objects) {
		for (const key in object.properties) {
			if (Object.prototype.hasOwnProperty.call(properties, key)) continue;
			const parts = [];
			for (const other of objects) {
				const part = other.properties?.[key] ?? undeclaredConstraint(other);
				if (part === null || part === void 0) continue;
				if (!parts.some((seen) => JSON.stringify(seen) === JSON.stringify(part))) parts.push(part);
			}
			assignProp(properties, key, parts.length === 1 ? parts[0] : foldObjects(parts) ?? { allOf: parts });
		}
		for (const key of object.required ?? []) required.add(key);
	}
	const folded = {
		type: "object",
		properties
	};
	if (required.size) folded.required = [...required];
	if (objects.every((object) => object.additionalProperties === false)) folded.additionalProperties = false;
	else {
		const constraints = [];
		for (const object of objects) {
			const constraint = undeclaredConstraint(object);
			if (constraint && !constraints.some((seen) => JSON.stringify(seen) === JSON.stringify(constraint))) constraints.push(constraint);
		}
		if (constraints.length === 1) folded.additionalProperties = constraints[0];
		else if (constraints.length > 1) folded.additionalProperties = { allOf: constraints };
	}
	return folded;
}
/** `additionalProperties` in an `allOf` member sees only that member's own `properties`, so two
* closed object members reject each other's keys and the schema validates nothing. Zod's parser
* pools the key sets instead — `handleIntersectionResults` reports a key as unrecognized only when
* *every* side rejects it — so the emitted schema has to pool them too, and folding the members
* into one object is the encoding that says so on every target.
*
* This runs from `finalize`, after `extractDefs`, which is what keeps it clear of the `$ref`
* machinery: a member extracted into `$defs` is already a `$ref` by now and declines to fold, so it
* keeps its reference and its own closedness rather than being inlined as a stale copy. */
function foldIntersection(json) {
	const allOf = json.allOf;
	if (!Array.isArray(allOf) || allOf.length < 2) return;
	for (const key of FOLDABLE_KEYS) if (key in json) return;
	const unions = allOf.filter((m) => UNION_KEYS.some((k) => Array.isArray(m[k])));
	let folded = null;
	if (!unions.length) folded = foldObjects(allOf);
	else {
		const union = unions[0];
		const keyword = UNION_KEYS.find((k) => Array.isArray(union[k]));
		if (Object.keys(union).length !== 1) return;
		const rest = allOf.filter((m) => m !== union);
		const branches = union[keyword].map((branch) => foldObjects([...rest, branch]));
		if (branches.some((b) => !b)) return;
		folded = { [keyword]: branches };
	}
	if (!folded) return;
	delete json.allOf;
	assignProps(json, folded);
}
function finalize(ctx, schema) {
	const root = ctx.seen.get(schema);
	if (!root) throw new Error("Unprocessed schema. This is a bug in Zod.");
	const flattenRef = (zodSchema) => {
		const seen = ctx.seen.get(zodSchema);
		if (seen.ref === null) return;
		const schema = seen.def ?? seen.schema;
		const _cached = { ...schema };
		const ref = seen.ref;
		seen.ref = null;
		if (ref) {
			flattenRef(ref);
			const refSeen = ctx.seen.get(ref);
			const refSchema = refSeen.schema;
			if (refSchema.$ref && (ctx.target === "draft-07" || ctx.target === "draft-04" || ctx.target === "openapi-3.0")) {
				schema.allOf = schema.allOf ?? [];
				schema.allOf.push(refSchema);
			} else assignProps(schema, refSchema);
			assignProps(schema, _cached);
			if (zodSchema._zod.parent === ref) for (const key in schema) {
				if (key === "$ref" || key === "allOf") continue;
				if (!(key in _cached)) delete schema[key];
			}
			if (refSchema.$ref && refSeen.def) for (const key in schema) {
				if (key === "$ref" || key === "allOf") continue;
				if (key in refSeen.def && JSON.stringify(schema[key]) === JSON.stringify(refSeen.def[key])) delete schema[key];
			}
		}
		const parent = zodSchema._zod.parent;
		if (parent && parent !== ref) {
			flattenRef(parent);
			const parentSeen = ctx.seen.get(parent);
			if (parentSeen?.schema.$ref) {
				schema.$ref = parentSeen.schema.$ref;
				if (parentSeen.def) for (const key in schema) {
					if (key === "$ref" || key === "allOf") continue;
					if (key in parentSeen.def && JSON.stringify(schema[key]) === JSON.stringify(parentSeen.def[key])) delete schema[key];
				}
			}
		}
		ctx.override({
			zodSchema,
			jsonSchema: schema,
			path: seen.path ?? []
		});
	};
	if (!ctx.external || ctx.sharedEmitDoneFor !== ctx.external) {
		for (const entry of [...ctx.seen.entries()].reverse()) flattenRef(entry[0]);
		if (ctx.target !== "openapi-3.0") for (const entry of ctx.seen.entries()) compactTypeUnion(entry[1].def ?? entry[1].schema);
		for (const rewrite of ctx.deferred) rewrite();
		if (ctx.intersections.length) {
			const carriers = /* @__PURE__ */ new Map();
			for (const seen of ctx.seen.values()) for (const json of [seen.schema, seen.def]) {
				const allOf = json?.allOf;
				if (!Array.isArray(allOf)) continue;
				const existing = carriers.get(allOf);
				if (existing) existing.push(json);
				else carriers.set(allOf, [json]);
			}
			for (const allOf of ctx.intersections) for (const json of carriers.get(allOf) ?? []) foldIntersection(json);
		}
	}
	const result = {};
	if (ctx.target === "draft-2020-12") result.$schema = "https://json-schema.org/draft/2020-12/schema";
	else if (ctx.target === "draft-07") result.$schema = "http://json-schema.org/draft-07/schema#";
	else if (ctx.target === "draft-04") result.$schema = "http://json-schema.org/draft-04/schema#";
	else if (ctx.target === "openapi-3.0") {}
	if (ctx.external?.uri) {
		const id = ctx.external.registry.get(schema)?.id;
		if (!id) throw new Error("Schema is missing an `id` property");
		result.$id = ctx.external.uri(id);
	}
	assignProps(result, root.defId ? root.schema : root.def ?? root.schema);
	const rootMetaId = ctx.metadataRegistry.get(schema)?.id;
	if (rootMetaId !== void 0 && result.id === rootMetaId) delete result.id;
	const defs = ctx.external?.defs ?? {};
	if (!ctx.external || ctx.sharedEmitDoneFor !== ctx.external) for (const entry of ctx.seen.entries()) {
		const seen = entry[1];
		if (seen.def && seen.defId) {
			if (seen.def.id === seen.defId) delete seen.def.id;
			assignProp(defs, seen.defId, seen.def);
		}
	}
	if (ctx.external) ctx.sharedEmitDoneFor = ctx.external;
	if (ctx.external) {} else if (Object.keys(defs).length > 0) {
		if (ctx.target === "draft-2020-12") result.$defs = defs;
		else result.definitions = defs;
	}
	try {
		const finalized = JSON.parse(JSON.stringify(result));
		Object.defineProperty(finalized, "~standard", {
			value: {
				...schema["~standard"],
				jsonSchema: {
					input: createStandardJSONSchemaMethod(schema, "input", ctx.processors),
					output: createStandardJSONSchemaMethod(schema, "output", ctx.processors)
				}
			},
			enumerable: false,
			writable: false
		});
		return finalized;
	} catch (_err) {
		throw new Error("Error converting schema to JSON.");
	}
}
function isTransforming(_schema, _ctx) {
	const ctx = _ctx ?? { seen: /* @__PURE__ */ new Set() };
	if (ctx.seen.has(_schema)) return false;
	ctx.seen.add(_schema);
	const def = _schema._zod.def;
	if (def.type === "transform") return true;
	if (def.type === "array") return isTransforming(def.element, ctx);
	if (def.type === "set") return isTransforming(def.valueType, ctx);
	if (def.type === "lazy") return isTransforming(def.getter(), ctx);
	if (def.type === "promise" || def.type === "optional" || def.type === "nonoptional" || def.type === "nullable" || def.type === "readonly" || def.type === "default" || def.type === "prefault" || def.type === "catch") return isTransforming(def.innerType, ctx);
	if (def.type === "intersection") return isTransforming(def.left, ctx) || isTransforming(def.right, ctx);
	if (def.type === "record" || def.type === "map") return isTransforming(def.keyType, ctx) || isTransforming(def.valueType, ctx);
	if (def.type === "pipe") {
		if (_schema._zod.traits.has("$ZodCodec")) return true;
		return isTransforming(def.in, ctx) || isTransforming(def.out, ctx);
	}
	if (def.type === "object") {
		for (const key in def.shape) if (isTransforming(def.shape[key], ctx)) return true;
		return false;
	}
	if (def.type === "union") {
		for (const option of def.options) if (isTransforming(option, ctx)) return true;
		return false;
	}
	if (def.type === "tuple") {
		for (const item of def.items) if (isTransforming(item, ctx)) return true;
		if (def.rest && isTransforming(def.rest, ctx)) return true;
		return false;
	}
	return false;
}
/**
* Creates a toJSONSchema method for a schema instance.
* This encapsulates the logic of initializing context, processing, extracting defs, and finalizing.
*/
var createToJSONSchemaMethod = (schema, processors = {}) => (params) => {
	const ctx = initializeContext({
		...params,
		processors
	});
	processSchema(schema, ctx);
	extractDefs(ctx, schema);
	return finalize(ctx, schema);
};
var createStandardJSONSchemaMethod = (schema, io, processors = {}) => (params) => {
	const { libraryOptions, target } = params ?? {};
	const ctx = initializeContext({
		...libraryOptions ?? {},
		target,
		io,
		processors
	});
	processSchema(schema, ctx);
	extractDefs(ctx, schema);
	return finalize(ctx, schema);
};
// ../../node_modules/.bun/zod@4.6.7/node_modules/zod/v4/core/json-schema-processors.js
var narrowMin = (agg, key, value) => {
	if (agg[key] === void 0 || value > agg[key]) agg[key] = value;
};
var narrowMax = (agg, key, value) => {
	if (agg[key] === void 0 || value < agg[key]) agg[key] = value;
};
var narrowBoth = (agg, value) => {
	narrowMin(agg, "minimum", value);
	narrowMax(agg, "maximum", value);
};
var addDivisor = (agg, value) => {
	agg.multipleOf ?? (agg.multipleOf = []);
	if (!agg.multipleOf.includes(value)) agg.multipleOf.push(value);
};
var addPattern = (agg, pattern) => {
	agg.patterns ?? (agg.patterns = /* @__PURE__ */ new Set());
	agg.patterns.add(pattern);
};
var intersectMime = (agg, mime) => {
	agg.mime = agg.mime ? agg.mime.filter((m) => mime.includes(m)) : [...mime];
};
var setFormat = (agg, format) => {
	agg.format = format;
	if (format.includes("int")) agg.isInt = true;
};
var minContributor = (agg, def) => narrowMin(agg, "minimum", def.minimum);
var maxContributor = (agg, def) => narrowMax(agg, "maximum", def.maximum);
var formatContributor = (ranges) => (agg, def) => {
	setFormat(agg, def.format);
	const [minimum, maximum] = ranges[def.format];
	narrowMin(agg, "minimum", minimum);
	narrowMax(agg, "maximum", maximum);
};
var contributors = {
	greater_than: (agg, def) => narrowMin(agg, def.inclusive ? "minimum" : "exclusiveMinimum", def.value),
	less_than: (agg, def) => narrowMax(agg, def.inclusive ? "maximum" : "exclusiveMaximum", def.value),
	multiple_of: (agg, def) => addDivisor(agg, def.value),
	number_format: formatContributor(NUMBER_FORMAT_RANGES),
	bigint_format: formatContributor(BIGINT_FORMAT_RANGES),
	min_length: minContributor,
	max_length: maxContributor,
	length_equals: (agg, def) => narrowBoth(agg, def.length),
	min_size: minContributor,
	max_size: maxContributor,
	size_equals: (agg, def) => narrowBoth(agg, def.size),
	string_format: (agg, def) => {
		setFormat(agg, def.format);
		if (def.pattern) addPattern(agg, def.pattern);
		if (def.format === "base64" || def.format === "base64url") agg.contentEncoding = def.format;
		if (def.local || def.precision === -1) agg.laxFormat = true;
	},
	mime_type: (agg, def) => intersectMime(agg, def.mime)
};
function aggregateChecks(schema) {
	const agg = {};
	const def = schema._zod.def;
	const list = schema._zod.traits.has("$ZodCheck") ? [schema, ...def.checks ?? []] : def.checks ?? [];
	for (const ch of list) contributors[ch._zod.def.check]?.(agg, ch._zod.def);
	const bag = schema._zod.bag;
	if (bag.minimum !== void 0) narrowMin(agg, "minimum", bag.minimum);
	if (bag.exclusiveMinimum !== void 0) narrowMin(agg, "exclusiveMinimum", bag.exclusiveMinimum);
	if (bag.maximum !== void 0) narrowMax(agg, "maximum", bag.maximum);
	if (bag.exclusiveMaximum !== void 0) narrowMax(agg, "exclusiveMaximum", bag.exclusiveMaximum);
	if (bag.multipleOf !== void 0) addDivisor(agg, bag.multipleOf);
	if (bag.format !== void 0) {
		agg.format ?? (agg.format = bag.format);
		if (bag.format.includes("int")) agg.isInt = true;
	}
	if (bag.mime) intersectMime(agg, bag.mime);
	for (const pattern of bag.patterns ?? []) addPattern(agg, pattern);
	return agg;
}
var formatMap = {
	guid: "uuid",
	url: "uri",
	datetime: "date-time",
	json_string: "json-string",
	regex: ""
};
var exactPatterns = /* @__PURE__ */ new Map([[base64Charset, base64], [base64urlCharset, base64url]]);
var exactPattern = (p) => exactPatterns.get(p) ?? p;
var stringProcessor = (schema, ctx, _json, _params) => {
	const json = _json;
	json.type = "string";
	const { minimum, maximum, format, patterns, contentEncoding, laxFormat } = aggregateChecks(schema);
	if (typeof minimum === "number") json.minLength = minimum;
	if (typeof maximum === "number") json.maxLength = maximum;
	if (format) {
		json.format = formatMap[format] ?? format;
		if (json.format === "") delete json.format;
		if (format === "time" || laxFormat) delete json.format;
	}
	if (contentEncoding) json.contentEncoding = contentEncoding;
	if (patterns && patterns.size > 0) {
		const patternList = [...patterns].map(exactPattern);
		if (patternList.length === 1) json.pattern = patternList[0].source;
		else if (patternList.length > 1) json.allOf = [...patternList.map((regex) => ({
			...ctx.target === "draft-07" || ctx.target === "draft-04" || ctx.target === "openapi-3.0" ? { type: "string" } : {},
			pattern: regex.source
		}))];
	}
};
var numberProcessor = (schema, ctx, _json, params) => {
	const json = _json;
	const { minimum, maximum, multipleOf, exclusiveMaximum, exclusiveMinimum, isInt } = aggregateChecks(schema);
	json.type = isInt ? "integer" : "number";
	const exMin = typeof exclusiveMinimum === "number" && exclusiveMinimum >= (minimum ?? Number.NEGATIVE_INFINITY);
	const exMax = typeof exclusiveMaximum === "number" && exclusiveMaximum <= (maximum ?? Number.POSITIVE_INFINITY);
	const legacy = ctx.target === "draft-04" || ctx.target === "openapi-3.0";
	if (exMin) {
		if (legacy) {
			json.minimum = exclusiveMinimum;
			json.exclusiveMinimum = true;
		} else json.exclusiveMinimum = exclusiveMinimum;
	} else if (typeof minimum === "number") json.minimum = minimum;
	if (exMax) {
		if (legacy) {
			json.maximum = exclusiveMaximum;
			json.exclusiveMaximum = true;
		} else json.exclusiveMaximum = exclusiveMaximum;
	} else if (typeof maximum === "number") json.maximum = maximum;
	if (multipleOf) {
		const divisors = /* @__PURE__ */ new Set();
		for (const divisor of multipleOf) if (Number.isFinite(divisor) && divisor !== 0) divisors.add(Math.abs(divisor));
		else handleUnrepresentable(schema, ctx, json, params, `A multipleOf divisor of ${divisor} cannot be represented in JSON Schema`);
		const [first, ...rest] = divisors;
		if (first !== void 0) json.multipleOf = first;
		if (rest.length) json.allOf = [...json.allOf ?? [], ...rest.map((m) => ({ multipleOf: m }))];
	}
};
var booleanProcessor = (_schema, _ctx, json, _params) => {
	json.type = "boolean";
};
var neverProcessor = (_schema, _ctx, json, _params) => {
	json.not = {};
};
var enumProcessor = (schema, _ctx, json, _params) => {
	const def = schema._zod.def;
	const values = getEnumValues(def.entries);
	if (values.length === 0) {
		json.not = {};
		return;
	}
	if (values.every((v) => typeof v === "number")) json.type = "number";
	if (values.every((v) => typeof v === "string")) json.type = "string";
	json.enum = values;
};
var customProcessor = (schema, ctx, json, params) => {
	handleUnrepresentable(schema, ctx, json, params, "Custom types cannot be represented in JSON Schema");
};
var transformProcessor = (schema, ctx, json, params) => {
	handleUnrepresentable(schema, ctx, json, params, "Transforms cannot be represented in JSON Schema");
};
var arrayProcessor = (schema, ctx, _json, params) => {
	const json = _json;
	const def = schema._zod.def;
	const { minimum, maximum } = aggregateChecks(schema);
	if (typeof minimum === "number") json.minItems = minimum;
	if (typeof maximum === "number") json.maxItems = maximum;
	json.type = "array";
	json.items = processSchema(def.element, ctx, {
		...params,
		path: [...params.path, "items"]
	});
};
function inputOptin(schema) {
	const def = schema._zod.def;
	if (def.type === "pipe" && def.in._zod.traits.has("$ZodTransform")) return inputOptin(def.out);
	if (def.type === "catch") return inputOptin(def.innerType);
	return schema._zod.optin;
}
var objectProcessor = (schema, ctx, _json, params) => {
	const json = _json;
	const def = schema._zod.def;
	const shape = def.shape;
	if (Object.getOwnPropertySymbols(shape).length && handleUnrepresentable(schema, ctx, json, params, "Symbol keys cannot be represented in JSON Schema")) return;
	json.type = "object";
	json.properties = {};
	for (const key in shape) assignProp(json.properties, key, processSchema(shape[key], ctx, {
		...params,
		path: [
			...params.path,
			"properties",
			key
		]
	}));
	const requiredKeys = [];
	for (const key of Object.keys(shape)) {
		const field = def.shape[key];
		if (ctx.io === "input" ? inputOptin(field) === void 0 : field._zod.optout === void 0) requiredKeys.push(key);
	}
	if (requiredKeys.length > 0) json.required = requiredKeys;
	if (def.catchall?._zod.def.type === "never") json.additionalProperties = false;
	else if (!def.catchall) {
		if (ctx.io === "output") json.additionalProperties = false;
	} else if (def.catchall) json.additionalProperties = processSchema(def.catchall, ctx, {
		...params,
		path: [...params.path, "additionalProperties"]
	});
};
var unionProcessor = (schema, ctx, json, params) => {
	const def = schema._zod.def;
	const isExclusive = def.inclusive === false;
	const options = def.options.map((x, i) => processSchema(x, ctx, {
		...params,
		path: [
			...params.path,
			isExclusive ? "oneOf" : "anyOf",
			i
		]
	}));
	if (isExclusive) json.oneOf = options;
	else json.anyOf = options;
};
var intersectionProcessor = (schema, ctx, json, params) => {
	const def = schema._zod.def;
	const a = processSchema(def.left, ctx, {
		...params,
		path: [
			...params.path,
			"allOf",
			0
		]
	});
	const b = processSchema(def.right, ctx, {
		...params,
		path: [
			...params.path,
			"allOf",
			1
		]
	});
	const isSimpleIntersection = (val) => "allOf" in val && Object.keys(val).length === 1;
	const allOf = [...isSimpleIntersection(a) ? a.allOf : [a], ...isSimpleIntersection(b) ? b.allOf : [b]];
	json.allOf = allOf;
	ctx.intersections.push(allOf);
};
/** JSON object keys are always strings, so a numeric record key schema is re-expressed over the
* numeric-string form the record parser matches. Deferred to `finalize`, after the flatten: a key
* behind a wrapper only carries its own `type` before then, and a union key only has its branches.
*
* A numeric bound cannot apply to a property name, so `minimum` and its siblings are dropped rather
* than carried over: keeping them beside `type: "string"` reproduces the match-nothing schema this
* exists to fix. A key that carries one therefore emits wider than the record parses — `z.record(z.number().min(5), V)`
* accepts `"3"` — which is the deliberate trade, since throwing on it would reject an ordinary schema
* outright. */
function stringifyKeyNames(bySchema, json, visited) {
	if (json.$ref) {
		if (visited.has(json)) return json;
		visited.add(json);
		const def = bySchema.get(json)?.def;
		if (!def) return json;
		const inlined = stringifyKeyNames(bySchema, def, visited);
		return inlined === def ? json : inlined;
	}
	for (const keyword of ["anyOf", "oneOf"]) {
		const branches = json[keyword];
		if (!Array.isArray(branches)) continue;
		const mapped = branches.map((branch) => stringifyKeyNames(bySchema, branch, visited));
		if (mapped.some((branch, i) => branch !== branches[i])) json = {
			...json,
			[keyword]: mapped
		};
	}
	const types = Array.isArray(json.type) ? json.type : [json.type];
	const numericType = !types.includes("string") && types.some((t) => t === "number" || t === "integer");
	const values = json.enum ?? (json.const !== void 0 ? [json.const] : void 0);
	if (!numericType && !values?.some((v) => typeof v === "number")) return json;
	const { minimum, maximum, exclusiveMinimum, exclusiveMaximum, multipleOf, format, id, ...rest } = json;
	if (rest.enum) rest.enum = rest.enum.map((v) => typeof v === "number" ? String(v) : v);
	else if (typeof rest.const === "number") rest.const = String(rest.const);
	if (!numericType) return rest;
	rest.type = "string";
	if (!values) rest.pattern = (types.includes("number") ? number$1 : integer).source;
	return rest;
}
/** Every record of one conversion, so the carriers are found in a single pass rather than once per record. */
var pendingRecords = /* @__PURE__ */ new WeakMap();
function rewriteKeyNames(ctx) {
	const bySchema = /* @__PURE__ */ new Map();
	for (const entry of ctx.seen.values()) if (entry.def && !bySchema.has(entry.schema)) bySchema.set(entry.schema, entry);
	const rewrites = /* @__PURE__ */ new Map();
	for (const record of pendingRecords.get(ctx) ?? []) {
		const seen = ctx.seen.get(record);
		const names = (seen?.def ?? seen?.schema)?.propertyNames;
		if (!names || names === true || rewrites.has(names)) continue;
		const rewritten = stringifyKeyNames(bySchema, names, /* @__PURE__ */ new Set());
		if (rewritten !== names) rewrites.set(names, rewritten);
	}
	if (!rewrites.size) return;
	for (const entry of ctx.seen.values()) for (const carrier of [entry.schema, entry.def]) {
		const rewritten = carrier && rewrites.get(carrier.propertyNames);
		if (rewritten) carrier.propertyNames = rewritten;
	}
}
var recordProcessor = (schema, ctx, _json, params) => {
	const json = _json;
	const def = schema._zod.def;
	json.type = "object";
	const keyType = def.keyType;
	const patterns = aggregateChecks(keyType).patterns;
	if (def.mode === "loose" && patterns && patterns.size > 0) {
		const valueSchema = processSchema(def.valueType, ctx, {
			...params,
			path: [
				...params.path,
				"patternProperties",
				"*"
			]
		});
		json.patternProperties = {};
		for (const pattern of patterns) assignProp(json.patternProperties, exactPattern(pattern).source, valueSchema);
	} else {
		if (ctx.target === "draft-07" || ctx.target === "draft-2020-12") {
			json.propertyNames = processSchema(def.keyType, ctx, {
				...params,
				path: [...params.path, "propertyNames"]
			});
			let pending = pendingRecords.get(ctx);
			if (!pending) {
				pending = [];
				pendingRecords.set(ctx, pending);
				ctx.deferred.push(() => rewriteKeyNames(ctx));
			}
			pending.push(schema);
		}
		json.additionalProperties = processSchema(def.valueType, ctx, {
			...params,
			path: [...params.path, "additionalProperties"]
		});
	}
	const keyValues = keyType._zod.values;
	const omittableOnInput = ctx.io === "input" && inputOptin(def.valueType) !== void 0;
	if (keyValues && !def.partial && !omittableOnInput) {
		const validKeyValues = [...keyValues].filter((v) => typeof v === "string" || typeof v === "number");
		if (validKeyValues.length > 0) json.required = validKeyValues.map(String);
	}
};
var nullableProcessor = (schema, ctx, json, params) => {
	const def = schema._zod.def;
	const inner = processSchema(def.innerType, ctx, params);
	const seen = ctx.seen.get(schema);
	if (ctx.target === "openapi-3.0") {
		seen.ref = def.innerType;
		json.nullable = true;
	} else json.anyOf = [inner, { type: "null" }];
};
var nonoptionalProcessor = (schema, ctx, _json, params) => {
	const def = schema._zod.def;
	processSchema(def.innerType, ctx, params);
	const seen = ctx.seen.get(schema);
	seen.ref = def.innerType;
};
/** Round-trips a default value through JSON so the emitted schema is guaranteed to be valid JSON.
* A BigInt has no reliable encoding, so it goes through `unrepresentable` like any other
* unrepresentable value. Returns a sentinel when the caller must not write a default of its own. */
var UNREPRESENTABLE_DEFAULT = Symbol();
function serializeDefaultValue(value, schema, ctx, json, params) {
	let unrepresentable = false;
	const serialized = JSON.stringify(value, (_, val) => {
		if (typeof val !== "bigint") return val;
		unrepresentable = true;
		return null;
	});
	if (!unrepresentable) return JSON.parse(serialized);
	handleUnrepresentable(schema, ctx, json, params, "BigInt defaults cannot be represented in JSON Schema");
	return UNREPRESENTABLE_DEFAULT;
}
var defaultProcessor = (schema, ctx, json, params) => {
	const def = schema._zod.def;
	processSchema(def.innerType, ctx, params);
	const seen = ctx.seen.get(schema);
	seen.ref = def.innerType;
	const value = serializeDefaultValue(def.defaultValue, schema, ctx, json, params);
	if (value !== UNREPRESENTABLE_DEFAULT) json.default = value;
};
var prefaultProcessor = (schema, ctx, json, params) => {
	const def = schema._zod.def;
	processSchema(def.innerType, ctx, params);
	const seen = ctx.seen.get(schema);
	seen.ref = def.innerType;
	if (ctx.io !== "input") return;
	const value = serializeDefaultValue(def.defaultValue, schema, ctx, json, params);
	if (value !== UNREPRESENTABLE_DEFAULT) json._prefault = value;
};
var catchProcessor = (schema, ctx, json, params) => {
	const def = schema._zod.def;
	processSchema(def.innerType, ctx, params);
	const seen = ctx.seen.get(schema);
	seen.ref = def.innerType;
	let catchValue;
	try {
		catchValue = def.catchValue(void 0);
	} catch {
		handleUnrepresentable(schema, ctx, json, params, "Dynamic catch values are not supported in JSON Schema");
		return;
	}
	json.default = catchValue;
};
var pipeProcessor = (schema, ctx, _json, params) => {
	const def = schema._zod.def;
	const inIsTransform = def.in._zod.traits.has("$ZodTransform");
	const innerType = ctx.io === "input" ? inIsTransform ? def.out : def.in : def.out;
	processSchema(innerType, ctx, params);
	const seen = ctx.seen.get(schema);
	seen.ref = innerType;
};
var readonlyProcessor = (schema, ctx, json, params) => {
	const def = schema._zod.def;
	processSchema(def.innerType, ctx, params);
	const seen = ctx.seen.get(schema);
	seen.ref = def.innerType;
	json.readOnly = true;
};
var optionalProcessor = (schema, ctx, _json, params) => {
	const def = schema._zod.def;
	processSchema(def.innerType, ctx, params);
	const seen = ctx.seen.get(schema);
	seen.ref = def.innerType;
};
// ../../node_modules/.bun/zod@4.6.7/node_modules/zod/v4/classic/errors.js
var _installedErrorProtos = /* @__PURE__ */ new WeakSet([Object.prototype, Error.prototype]);
function _lazyMethod(proto, key, make) {
	Object.defineProperty(proto, key, {
		configurable: true,
		enumerable: false,
		get() {
			const value = make(this);
			Object.defineProperty(this, key, {
				value,
				configurable: true,
				writable: true
			});
			return value;
		},
		set(value) {
			Object.defineProperty(this, key, {
				value,
				configurable: true,
				writable: true
			});
		}
	});
}
var initializer = (inst, issues) => {
	$ZodError.init(inst, issues);
	inst.name = "ZodError";
	const proto = Object.getPrototypeOf(inst);
	if (_installedErrorProtos.has(proto)) return;
	_installedErrorProtos.add(proto);
	_lazyMethod(proto, "format", (self) => (mapper) => formatError(self, mapper));
	_lazyMethod(proto, "flatten", (self) => (mapper) => flattenError(self, mapper));
	_lazyMethod(proto, "addIssue", (self) => (issue) => {
		self.issues.push(issue);
		self.message = JSON.stringify(self.issues, jsonStringifyReplacer, 2);
	});
	_lazyMethod(proto, "addIssues", (self) => (issues) => {
		self.issues.push(...issues);
		self.message = JSON.stringify(self.issues, jsonStringifyReplacer, 2);
	});
	Object.defineProperty(proto, "isEmpty", {
		configurable: true,
		enumerable: false,
		get() {
			return this.issues.length === 0;
		}
	});
};
var ZodRealError = /*@__PURE__*/ $constructor("ZodError", initializer, void 0, { Parent: Error });
// ../../node_modules/.bun/zod@4.6.7/node_modules/zod/v4/classic/parse.js
var parse = /* @__PURE__ */ _parse(ZodRealError);
var parseAsync = /* @__PURE__ */ _parseAsync(ZodRealError);
var safeParse = /* @__PURE__ */ _safeParse(ZodRealError);
var safeParseAsync = /* @__PURE__ */ _safeParseAsync(ZodRealError);
var encode = /* @__PURE__ */ _encode(ZodRealError);
var decode = /* @__PURE__ */ _decode(ZodRealError);
var encodeAsync = /* @__PURE__ */ _encodeAsync(ZodRealError);
var decodeAsync = /* @__PURE__ */ _decodeAsync(ZodRealError);
var safeEncode = /* @__PURE__ */ _safeEncode(ZodRealError);
var safeDecode = /* @__PURE__ */ _safeDecode(ZodRealError);
var safeEncodeAsync = /* @__PURE__ */ _safeEncodeAsync(ZodRealError);
var safeDecodeAsync = /* @__PURE__ */ _safeDecodeAsync(ZodRealError);
// ../../node_modules/.bun/zod@4.6.7/node_modules/zod/v4/classic/schemas.js
function _ensureDefaultLocale() {
	if (!globalConfig.localeError) config(en_default());
}
function _ensureDefaultMemoizer() {
	if (!globalConfig.memoizer) config({ memoizer: memoizer() });
}
var ZodType = /*@__PURE__*/ $constructor("ZodType", (inst, def) => {
	_ensureDefaultLocale();
	$ZodType.init(inst, def);
	inst.def = def;
	inst.type = def.type;
	return inst;
}, {
	check(...chks) {
		const def = this.def;
		return this.clone(mergeDefs(def, { checks: [...def.checks ?? [], ...chks.map((ch) => typeof ch === "function" ? { _zod: {
			check: ch,
			def: { check: "custom" },
			onattach: []
		} } : ch)] }), { parent: true });
	},
	with(...chks) {
		return this.check(...chks);
	},
	clone(def, params) {
		return clone(this, def, params);
	},
	brand() {
		return this;
	},
	register(reg, meta) {
		reg.add(this, meta);
		return this;
	},
	refine(check, params) {
		return this.check(refine(check, params));
	},
	superRefine(refinement, params) {
		return this.check(superRefine(refinement, params));
	},
	overwrite(fn) {
		return this.check(/* @__PURE__ */ _overwrite(fn));
	},
	optional() {
		return optional(this);
	},
	exactOptional() {
		return exactOptional(this);
	},
	nullable() {
		return nullable(this);
	},
	nullish() {
		return optional(nullable(this));
	},
	nonoptional(params) {
		return nonoptional(this, params);
	},
	array() {
		return array(this);
	},
	or(arg) {
		return union([this, arg]);
	},
	and(arg) {
		return intersection(this, arg);
	},
	transform(tx) {
		return pipe(this, transform(tx));
	},
	default(d) {
		return _default(this, d);
	},
	prefault(d) {
		return prefault(this, d);
	},
	catch(params) {
		return _catch(this, params);
	},
	pipe(target) {
		return pipe(this, target);
	},
	readonly() {
		return readonly(this);
	},
	describe(description) {
		const cl = this.clone();
		globalRegistry.add(cl, { description });
		return cl;
	},
	meta(...args) {
		if (args.length === 0) return globalRegistry.get(this);
		const cl = this.clone();
		globalRegistry.add(cl, args[0]);
		return cl;
	},
	isOptional() {
		return this.safeParse(void 0).success;
	},
	isNullable() {
		return this.safeParse(null).success;
	},
	apply(fn, ...args) {
		return args.length === 0 ? fn(this) : fn(this, ...args);
	},
	get "~standard"() {
		return hide(this, "~standard", {
			...standardProps(this),
			jsonSchema: {
				input: createStandardJSONSchemaMethod(this, "input"),
				output: createStandardJSONSchemaMethod(this, "output")
			}
		});
	},
	set "~standard"(value) {
		own(this, "~standard", value);
	},
	parse: function _parse(data, params) {
		return parse(this, data, params, { callee: _parse });
	},
	parseAsync: async function _parseAsync(data, params) {
		return await parseAsync(this, data, params, { callee: _parseAsync });
	},
	safeParse(data, params) {
		return safeParse(this, data, params);
	},
	async safeParseAsync(data, params) {
		return safeParseAsync(this, data, params);
	},
	get spa() {
		return this?.safeParseAsync;
	},
	set spa(value) {
		own(this, "spa", value);
	},
	validate(data, params) {
		return validate(this, data, params);
	},
	validateAsync(data, params) {
		return validateAsync$1(this, data, params);
	},
	encode: function _encode(data, params) {
		return encode(this, data, params, { callee: _encode });
	},
	decode: function _decode(data, params) {
		return decode(this, data, params, { callee: _decode });
	},
	encodeAsync: async function _encodeAsync(data, params) {
		return await encodeAsync(this, data, params, { callee: _encodeAsync });
	},
	decodeAsync: async function _decodeAsync(data, params) {
		return await decodeAsync(this, data, params, { callee: _decodeAsync });
	},
	safeEncode(data, params) {
		return safeEncode(this, data, params);
	},
	safeDecode(data, params) {
		return safeDecode(this, data, params);
	},
	async safeEncodeAsync(data, params) {
		return safeEncodeAsync(this, data, params);
	},
	async safeDecodeAsync(data, params) {
		return safeDecodeAsync(this, data, params);
	},
	toJSONSchema(params) {
		return createToJSONSchemaMethod(this, {})(params);
	},
	get description() {
		return globalRegistry.get(this)?.description;
	},
	get _def() {
		return this._zod.def;
	}
});
/** @internal */
var _ZodString = /*@__PURE__*/ $constructor("_ZodString", (inst, def) => {
	$ZodString.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => stringProcessor(inst, ctx, json, params);
}, /*@__PURE__*/ derived({
	format: (inst) => aggregateChecks(inst).format ?? null,
	minLength: (inst) => aggregateChecks(inst).minimum ?? null,
	maxLength: (inst) => aggregateChecks(inst).maximum ?? null
}, {
	regex(...args) {
		return this.check(/* @__PURE__ */ _regex(...args));
	},
	includes(...args) {
		return this.check(/* @__PURE__ */ _includes(...args));
	},
	startsWith(...args) {
		return this.check(/* @__PURE__ */ _startsWith(...args));
	},
	endsWith(...args) {
		return this.check(/* @__PURE__ */ _endsWith(...args));
	},
	min(...args) {
		return this.check(/* @__PURE__ */ _minLength(...args));
	},
	max(...args) {
		return this.check(/* @__PURE__ */ _maxLength(...args));
	},
	length(...args) {
		return this.check(/* @__PURE__ */ _length(...args));
	},
	nonempty(...args) {
		return this.check(/* @__PURE__ */ _minLength(1, ...args));
	},
	lowercase(params) {
		return this.check(/* @__PURE__ */ _lowercase(params));
	},
	uppercase(params) {
		return this.check(/* @__PURE__ */ _uppercase(params));
	},
	trim() {
		return this.check(/* @__PURE__ */ _trim());
	},
	normalize(...args) {
		return this.check(/* @__PURE__ */ _normalize(...args));
	},
	toLowerCase() {
		return this.check(/* @__PURE__ */ _toLowerCase());
	},
	toUpperCase() {
		return this.check(/* @__PURE__ */ _toUpperCase());
	},
	slugify() {
		return this.check(/* @__PURE__ */ _slugify());
	}
}));
var ZodString = /*@__PURE__*/ $constructor("ZodString", (inst, def) => {
	$ZodString.init(inst, def);
	_ZodString.init(inst, def);
}, {
	email(params) {
		return this.check(/* @__PURE__ */ _email(ZodEmail, params));
	},
	url(params) {
		return this.check(/* @__PURE__ */ _url(ZodURL, params));
	},
	jwt(params) {
		return this.check(/* @__PURE__ */ _jwt(ZodJWT, params));
	},
	emoji(params) {
		return this.check(/* @__PURE__ */ _emoji(ZodEmoji, params));
	},
	guid(params) {
		return this.check(/* @__PURE__ */ _guid(ZodGUID, params));
	},
	uuid(params) {
		return this.check(/* @__PURE__ */ _uuid(ZodUUID, params));
	},
	uuidv4(params) {
		return this.check(/* @__PURE__ */ _uuidv4(ZodUUID, params));
	},
	uuidv6(params) {
		return this.check(/* @__PURE__ */ _uuidv6(ZodUUID, params));
	},
	uuidv7(params) {
		return this.check(/* @__PURE__ */ _uuidv7(ZodUUID, params));
	},
	nanoid(params) {
		return this.check(/* @__PURE__ */ _nanoid(ZodNanoID, params));
	},
	cuid(params) {
		return this.check(/* @__PURE__ */ _cuid(ZodCUID, params));
	},
	cuid2(params) {
		return this.check(/* @__PURE__ */ _cuid2(ZodCUID2, params));
	},
	ulid(params) {
		return this.check(/* @__PURE__ */ _ulid(ZodULID, params));
	},
	base64(params) {
		return this.check(/* @__PURE__ */ _base64(ZodBase64, params));
	},
	base64url(params) {
		return this.check(/* @__PURE__ */ _base64url(ZodBase64URL, params));
	},
	xid(params) {
		return this.check(/* @__PURE__ */ _xid(ZodXID, params));
	},
	ksuid(params) {
		return this.check(/* @__PURE__ */ _ksuid(ZodKSUID, params));
	},
	ipv4(params) {
		return this.check(/* @__PURE__ */ _ipv4(ZodIPv4, params));
	},
	ipv6(params) {
		return this.check(/* @__PURE__ */ _ipv6(ZodIPv6, params));
	},
	cidrv4(params) {
		return this.check(/* @__PURE__ */ _cidrv4(ZodCIDRv4, params));
	},
	cidrv6(params) {
		return this.check(/* @__PURE__ */ _cidrv6(ZodCIDRv6, params));
	},
	e164(params) {
		return this.check(/* @__PURE__ */ _e164(ZodE164, params));
	},
	datetime(params) {
		return this.check(/* @__PURE__ */ _isoDateTime(ZodISODateTime, params));
	},
	date(params) {
		return this.check(/* @__PURE__ */ _isoDate(ZodISODate, params));
	},
	time(params) {
		return this.check(/* @__PURE__ */ _isoTime(ZodISOTime, params));
	},
	duration(params) {
		return this.check(/* @__PURE__ */ _isoDuration(ZodISODuration, params));
	}
});
function string$1(params) {
	return /* @__PURE__ */ _string(ZodString, params);
}
var ZodStringFormat = /*@__PURE__*/ $constructor("ZodStringFormat", (inst, def) => {
	$ZodStringFormat.init(inst, def);
	_ZodString.init(inst, def);
});
var ZodISODateTime = /*@__PURE__*/ $constructor("ZodISODateTime", (inst, def) => {
	$ZodISODateTime.init(inst, def);
	ZodStringFormat.init(inst, def);
});
var ZodISODate = /*@__PURE__*/ $constructor("ZodISODate", (inst, def) => {
	$ZodISODate.init(inst, def);
	ZodStringFormat.init(inst, def);
});
var ZodISOTime = /*@__PURE__*/ $constructor("ZodISOTime", (inst, def) => {
	$ZodISOTime.init(inst, def);
	ZodStringFormat.init(inst, def);
});
var ZodISODuration = /*@__PURE__*/ $constructor("ZodISODuration", (inst, def) => {
	$ZodISODuration.init(inst, def);
	ZodStringFormat.init(inst, def);
});
var ZodEmail = /*@__PURE__*/ $constructor("ZodEmail", (inst, def) => {
	$ZodEmail.init(inst, def);
	ZodStringFormat.init(inst, def);
});
var ZodGUID = /*@__PURE__*/ $constructor("ZodGUID", (inst, def) => {
	$ZodGUID.init(inst, def);
	ZodStringFormat.init(inst, def);
});
var ZodUUID = /*@__PURE__*/ $constructor("ZodUUID", (inst, def) => {
	$ZodUUID.init(inst, def);
	ZodStringFormat.init(inst, def);
});
var ZodURL = /*@__PURE__*/ $constructor("ZodURL", (inst, def) => {
	$ZodURL.init(inst, def);
	ZodStringFormat.init(inst, def);
});
var ZodEmoji = /*@__PURE__*/ $constructor("ZodEmoji", (inst, def) => {
	$ZodEmoji.init(inst, def);
	ZodStringFormat.init(inst, def);
});
var ZodNanoID = /*@__PURE__*/ $constructor("ZodNanoID", (inst, def) => {
	$ZodNanoID.init(inst, def);
	ZodStringFormat.init(inst, def);
});
/**
* @deprecated CUID v1 is deprecated by its authors due to information leakage
* (timestamps embedded in the id). Use {@link ZodCUID2} instead.
* See https://github.com/paralleldrive/cuid.
*/
var ZodCUID = /*@__PURE__*/ $constructor("ZodCUID", (inst, def) => {
	$ZodCUID.init(inst, def);
	ZodStringFormat.init(inst, def);
});
var ZodCUID2 = /*@__PURE__*/ $constructor("ZodCUID2", (inst, def) => {
	$ZodCUID2.init(inst, def);
	ZodStringFormat.init(inst, def);
});
var ZodULID = /*@__PURE__*/ $constructor("ZodULID", (inst, def) => {
	$ZodULID.init(inst, def);
	ZodStringFormat.init(inst, def);
});
var ZodXID = /*@__PURE__*/ $constructor("ZodXID", (inst, def) => {
	$ZodXID.init(inst, def);
	ZodStringFormat.init(inst, def);
});
var ZodKSUID = /*@__PURE__*/ $constructor("ZodKSUID", (inst, def) => {
	$ZodKSUID.init(inst, def);
	ZodStringFormat.init(inst, def);
});
var ZodIPv4 = /*@__PURE__*/ $constructor("ZodIPv4", (inst, def) => {
	$ZodIPv4.init(inst, def);
	ZodStringFormat.init(inst, def);
});
var ZodIPv6 = /*@__PURE__*/ $constructor("ZodIPv6", (inst, def) => {
	$ZodIPv6.init(inst, def);
	ZodStringFormat.init(inst, def);
});
var ZodCIDRv4 = /*@__PURE__*/ $constructor("ZodCIDRv4", (inst, def) => {
	$ZodCIDRv4.init(inst, def);
	ZodStringFormat.init(inst, def);
});
var ZodCIDRv6 = /*@__PURE__*/ $constructor("ZodCIDRv6", (inst, def) => {
	$ZodCIDRv6.init(inst, def);
	ZodStringFormat.init(inst, def);
});
var ZodBase64 = /*@__PURE__*/ $constructor("ZodBase64", (inst, def) => {
	$ZodBase64.init(inst, def);
	ZodStringFormat.init(inst, def);
});
var ZodBase64URL = /*@__PURE__*/ $constructor("ZodBase64URL", (inst, def) => {
	$ZodBase64URL.init(inst, def);
	ZodStringFormat.init(inst, def);
});
var ZodE164 = /*@__PURE__*/ $constructor("ZodE164", (inst, def) => {
	$ZodE164.init(inst, def);
	ZodStringFormat.init(inst, def);
});
var ZodJWT = /*@__PURE__*/ $constructor("ZodJWT", (inst, def) => {
	$ZodJWT.init(inst, def);
	ZodStringFormat.init(inst, def);
});
var ZodNumber = /*@__PURE__*/ $constructor("ZodNumber", (inst, def) => {
	$ZodNumber.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => numberProcessor(inst, ctx, json, params);
	inst.isFinite = true;
}, /*@__PURE__*/ derived({
	minValue: (inst) => {
		const { minimum, exclusiveMinimum } = aggregateChecks(inst);
		return Math.max(minimum ?? Number.NEGATIVE_INFINITY, exclusiveMinimum ?? Number.NEGATIVE_INFINITY);
	},
	maxValue: (inst) => {
		const { maximum, exclusiveMaximum } = aggregateChecks(inst);
		return Math.min(maximum ?? Number.POSITIVE_INFINITY, exclusiveMaximum ?? Number.POSITIVE_INFINITY);
	},
	isInt: (inst) => {
		const { isInt, multipleOf } = aggregateChecks(inst);
		return !!isInt || !!multipleOf?.some(Number.isSafeInteger);
	},
	format: (inst) => aggregateChecks(inst).format ?? null
}, {
	gt(value, params) {
		return this.check(/* @__PURE__ */ _gt(value, params));
	},
	gte(value, params) {
		return this.check(/* @__PURE__ */ _gte(value, params));
	},
	min(value, params) {
		return this.check(/* @__PURE__ */ _gte(value, params));
	},
	lt(value, params) {
		return this.check(/* @__PURE__ */ _lt(value, params));
	},
	lte(value, params) {
		return this.check(/* @__PURE__ */ _lte(value, params));
	},
	max(value, params) {
		return this.check(/* @__PURE__ */ _lte(value, params));
	},
	int(params) {
		return this.check(int(params));
	},
	safe(params) {
		return this.check(int(params));
	},
	positive(params) {
		return this.check(/* @__PURE__ */ _gt(0, params));
	},
	nonnegative(params) {
		return this.check(/* @__PURE__ */ _gte(0, params));
	},
	negative(params) {
		return this.check(/* @__PURE__ */ _lt(0, params));
	},
	nonpositive(params) {
		return this.check(/* @__PURE__ */ _lte(0, params));
	},
	multipleOf(value, params) {
		return this.check(/* @__PURE__ */ _multipleOf(value, params));
	},
	step(value, params) {
		return this.check(/* @__PURE__ */ _multipleOf(value, params));
	},
	finite() {
		return this;
	}
}));
function number(params) {
	return /* @__PURE__ */ _number(ZodNumber, params);
}
var ZodNumberFormat = /*@__PURE__*/ $constructor("ZodNumberFormat", (inst, def) => {
	$ZodNumberFormat.init(inst, def);
	ZodNumber.init(inst, def);
});
function int(params) {
	return /* @__PURE__ */ _int(ZodNumberFormat, params);
}
var ZodBoolean = /*@__PURE__*/ $constructor("ZodBoolean", (inst, def) => {
	$ZodBoolean.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => booleanProcessor(inst, ctx, json, params);
});
function boolean(params) {
	return /* @__PURE__ */ _boolean(ZodBoolean, params);
}
var ZodUnknown = /*@__PURE__*/ $constructor("ZodUnknown", (inst, def) => {
	$ZodUnknown.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => void 0;
});
function unknown() {
	return /* @__PURE__ */ _unknown(ZodUnknown);
}
var ZodNever = /*@__PURE__*/ $constructor("ZodNever", (inst, def) => {
	$ZodNever.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => neverProcessor(inst, ctx, json, params);
});
function never(params) {
	return /* @__PURE__ */ _never(ZodNever, params);
}
var ZodArray = /*@__PURE__*/ $constructor("ZodArray", (inst, def) => {
	_ensureDefaultMemoizer();
	$ZodArray.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => arrayProcessor(inst, ctx, json, params);
	inst.element = def.element;
}, {
	min(n, params) {
		return this.check(/* @__PURE__ */ _minLength(n, params));
	},
	nonempty(params) {
		return this.check(/* @__PURE__ */ _minLength(1, params));
	},
	max(n, params) {
		return this.check(/* @__PURE__ */ _maxLength(n, params));
	},
	length(n, params) {
		return this.check(/* @__PURE__ */ _length(n, params));
	},
	unwrap() {
		return this.element;
	}
});
function array(element, params) {
	return /* @__PURE__ */ _array(ZodArray, element, params);
}
var ZodObject = /*@__PURE__*/ $constructor("ZodObject", (inst, def) => {
	_ensureDefaultMemoizer();
	$ZodObjectJIT.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => objectProcessor(inst, ctx, json, params);
	installLazyProp(inst, "shape", (self) => self._zod.def.shape, false);
}, {
	keyof() {
		return _enum(Object.keys(this._zod.def.shape));
	},
	catchall(catchall) {
		return this.clone(mergeDefs(this._zod.def, { catchall }));
	},
	passthrough() {
		return this.clone(mergeDefs(this._zod.def, { catchall: unknown() }));
	},
	loose() {
		return this.clone(mergeDefs(this._zod.def, { catchall: unknown() }));
	},
	strict() {
		return this.clone(mergeDefs(this._zod.def, { catchall: never() }));
	},
	strip() {
		return this.clone(mergeDefs(this._zod.def, { catchall: void 0 }));
	},
	extend(incoming) {
		return extend(this, incoming);
	},
	safeExtend(incoming) {
		return safeExtend(this, incoming);
	},
	merge(other) {
		return merge(this, other);
	},
	pick(mask) {
		return pick(this, mask);
	},
	omit(mask) {
		return omit(this, mask);
	},
	partial(...args) {
		return partial(ZodOptional, this, args[0]);
	},
	exactPartial(...args) {
		return partial(ZodExactOptional, this, args[0], "exactPartial");
	},
	required(...args) {
		return required(ZodNonOptional, this, args[0]);
	}
});
function strictObject(shape, params) {
	return new ZodObject({
		type: "object",
		shape,
		catchall: never(),
		...normalizeParams(params)
	});
}
var ZodUnion = /*@__PURE__*/ $constructor("ZodUnion", (inst, def) => {
	$ZodUnion.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => unionProcessor(inst, ctx, json, params);
	inst.options = def.options;
});
function union(options, params) {
	return new ZodUnion({
		type: "union",
		options,
		...normalizeParams(params)
	});
}
var ZodIntersection = /*@__PURE__*/ $constructor("ZodIntersection", (inst, def) => {
	$ZodIntersection.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => intersectionProcessor(inst, ctx, json, params);
});
function intersection(left, right) {
	return new ZodIntersection({
		type: "intersection",
		left,
		right
	});
}
var ZodRecord = /*@__PURE__*/ $constructor("ZodRecord", (inst, def) => {
	_ensureDefaultMemoizer();
	$ZodRecord.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => recordProcessor(inst, ctx, json, params);
	inst.keyType = def.keyType;
	inst.valueType = def.valueType;
});
function record(keyType, valueType, params) {
	if (!valueType || !valueType._zod) return new ZodRecord({
		type: "record",
		keyType: string$1(),
		valueType: keyType,
		...normalizeParams(valueType)
	});
	return new ZodRecord({
		type: "record",
		keyType,
		valueType,
		...normalizeParams(params)
	});
}
function partialRecord(keyType, valueType, params) {
	return new ZodRecord({
		type: "record",
		keyType,
		valueType,
		...normalizeParams(params),
		partial: true
	});
}
var ZodEnum = /*@__PURE__*/ $constructor("ZodEnum", (inst, def) => {
	$ZodEnum.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => enumProcessor(inst, ctx, json, params);
	inst.enum = def.entries;
	inst.options = [...inst._zod.values];
	const keys = new Set(Object.keys(def.entries));
	inst.extract = (values, params) => {
		const newEntries = {};
		for (const value of values) if (keys.has(value)) newEntries[value] = def.entries[value];
		else throw new Error(`Key ${value} not found in enum`);
		return new ZodEnum({
			...def,
			checks: [],
			...normalizeParams(params),
			entries: newEntries
		});
	};
	inst.exclude = (values, params) => {
		const newEntries = { ...def.entries };
		for (const value of values) if (keys.has(value)) delete newEntries[value];
		else throw new Error(`Key ${value} not found in enum`);
		return new ZodEnum({
			...def,
			checks: [],
			...normalizeParams(params),
			entries: newEntries
		});
	};
});
function _enum(values, params) {
	return new ZodEnum({
		type: "enum",
		entries: Array.isArray(values) ? Object.fromEntries(values.map((v) => [v, v])) : values,
		...normalizeParams(params)
	});
}
var ZodTransform = /*@__PURE__*/ $constructor("ZodTransform", (inst, def) => {
	_ensureDefaultMemoizer();
	$ZodTransform.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => transformProcessor(inst, ctx, json, params);
	inst._zod.parse = (payload, _ctx) => {
		if (_ctx.direction === "backward") throw new $ZodEncodeError(inst.constructor.name);
		payload.addIssue = (issue$1) => {
			if (typeof issue$1 === "string") payload.issues.push(issue(issue$1, payload.value, def));
			else {
				const _issue = issue$1;
				if (_issue.fatal) _issue.continue = false;
				_issue.code ?? (_issue.code = "custom");
				if (!("input" in _issue)) _issue.input = payload.value;
				_issue.inst ?? (_issue.inst = inst);
				payload.issues.push(issue(_issue));
			}
		};
		const output = def.transform(payload.value, payload);
		if (output instanceof Promise) return output.then((output) => {
			payload.value = output;
			return payload;
		});
		payload.value = output;
		return payload;
	};
});
function transform(fn) {
	return new ZodTransform({
		type: "transform",
		transform: fn
	});
}
var ZodOptional = /*@__PURE__*/ $constructor("ZodOptional", (inst, def) => {
	$ZodOptional.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => optionalProcessor(inst, ctx, json, params);
	inst.unwrap = () => inst._zod.def.innerType;
});
function optional(innerType) {
	return new ZodOptional({
		type: "optional",
		innerType
	});
}
var ZodExactOptional = /*@__PURE__*/ $constructor("ZodExactOptional", (inst, def) => {
	$ZodExactOptional.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => optionalProcessor(inst, ctx, json, params);
	inst.unwrap = () => inst._zod.def.innerType;
});
function exactOptional(innerType) {
	return new ZodExactOptional({
		type: "optional",
		innerType
	});
}
var ZodNullable = /*@__PURE__*/ $constructor("ZodNullable", (inst, def) => {
	$ZodNullable.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => nullableProcessor(inst, ctx, json, params);
	inst.unwrap = () => inst._zod.def.innerType;
});
function nullable(innerType) {
	return new ZodNullable({
		type: "nullable",
		innerType
	});
}
var ZodDefault = /*@__PURE__*/ $constructor("ZodDefault", (inst, def) => {
	$ZodDefault.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => defaultProcessor(inst, ctx, json, params);
	inst.unwrap = () => inst._zod.def.innerType;
	inst.removeDefault = inst.unwrap;
});
function _default(innerType, defaultValue) {
	return new ZodDefault({
		type: "default",
		innerType,
		get defaultValue() {
			return typeof defaultValue === "function" ? defaultValue() : shallowClone(defaultValue);
		}
	});
}
var ZodPrefault = /*@__PURE__*/ $constructor("ZodPrefault", (inst, def) => {
	$ZodPrefault.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => prefaultProcessor(inst, ctx, json, params);
	inst.unwrap = () => inst._zod.def.innerType;
});
function prefault(innerType, defaultValue) {
	return new ZodPrefault({
		type: "prefault",
		innerType,
		get defaultValue() {
			return typeof defaultValue === "function" ? defaultValue() : shallowClone(defaultValue);
		}
	});
}
var ZodNonOptional = /*@__PURE__*/ $constructor("ZodNonOptional", (inst, def) => {
	$ZodNonOptional.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => nonoptionalProcessor(inst, ctx, json, params);
	inst.unwrap = () => inst._zod.def.innerType;
});
function nonoptional(innerType, params) {
	return new ZodNonOptional({
		type: "nonoptional",
		innerType,
		...normalizeParams(params)
	});
}
var ZodCatch = /*@__PURE__*/ $constructor("ZodCatch", (inst, def) => {
	$ZodCatch.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => catchProcessor(inst, ctx, json, params);
	inst.unwrap = () => inst._zod.def.innerType;
	inst.removeCatch = inst.unwrap;
});
function _catch(innerType, catchValue) {
	return new ZodCatch({
		type: "catch",
		innerType,
		catchValue: typeof catchValue === "function" ? catchValue : constantCatch(catchValue)
	});
}
var ZodPipe = /*@__PURE__*/ $constructor("ZodPipe", (inst, def) => {
	$ZodPipe.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => pipeProcessor(inst, ctx, json, params);
	inst.in = def.in;
	inst.out = def.out;
});
function pipe(in_, out) {
	return new ZodPipe({
		type: "pipe",
		in: in_,
		out
	});
}
var ZodReadonly = /*@__PURE__*/ $constructor("ZodReadonly", (inst, def) => {
	$ZodReadonly.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => readonlyProcessor(inst, ctx, json, params);
	inst.unwrap = () => inst._zod.def.innerType;
});
function readonly(innerType) {
	return new ZodReadonly({
		type: "readonly",
		innerType
	});
}
var ZodCustom = /*@__PURE__*/ $constructor("ZodCustom", (inst, def) => {
	$ZodCustom.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => customProcessor(inst, ctx, json, params);
});
function refine(fn, _params = {}) {
	return /* @__PURE__ */ _refine(ZodCustom, fn, _params);
}
function superRefine(fn, params) {
	return /* @__PURE__ */ _superRefine(fn, params);
}
// ../plugin-api/src/plugin.ts
/**
* What a plugin can do. The UI branches on these, never on a plugin id (decision 007), and a
* capability without contract-suite coverage cannot be declared (decision 013).
*/
var CAPABILITIES$1 = [
	"sql",
	"cancel",
	"schemaTree",
	"transactions",
	"ddl",
	"explain",
	"explainAnalyze",
	"currentNamespace",
	"keepAlive",
	"bulkInsert",
	"objects",
	"serverMessages",
	"sessions",
	"routineCall"
];
/**
* Whether a switch over `targets` can name `namespace`. Not by `Namespace.kind` alone: MySQL lists
* its databases as top-level schemas, so a `USE` picks a top-level namespace whatever its kind.
*/
function switchableTo(targets, namespace) {
	return targets === "topLevel" ? namespace.path.length === 1 : namespace.kind === "schema";
}
// ../plugin-api/src/version.ts
var SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
/** `major.minor.patch` and nothing else; pre-release and build tags are not accepted. */
function parseVersion(text) {
	const match = SEMVER.exec(text);
	if (match === null) return null;
	const [, major, minor, patch] = match;
	return {
		major: Number(major),
		minor: Number(minor),
		patch: Number(patch)
	};
}
// ../plugin-api/src/manifest.ts
var PLUGIN_ID$1 = /^[a-z][a-z0-9-]*$/;
var semver = string$1().refine((text) => parseVersion(text) !== null, { message: "expected major.minor.patch" });
/**
* What the loader reads before executing any plugin code, so an unavailable plugin can still be
* named in the UI.
*/
var CONNECTION_FIELD_KINDS = [
	"text",
	"number",
	"password",
	"file",
	"select",
	"checkbox"
];
var CONNECTION_FIELD_GROUPS = ["general", "advanced"];
var FIELD_KEY = /^[a-zA-Z][a-zA-Z0-9]*$/;
/**
* One control of the connection form (decision 019). `key` names the config property it fills;
* `secret` sends the value to the secret store instead of `datasources.json` (decision 020).
*/
var connectionFieldSchema = strictObject({
	key: string$1().regex(FIELD_KEY, { message: "expected a camelCase config key" }),
	label: string$1().min(1),
	kind: _enum(CONNECTION_FIELD_KINDS),
	default: union([
		string$1(),
		number(),
		boolean()
	]).optional(),
	required: boolean().optional(),
	placeholder: string$1().optional(),
	/** The choices of a `select`, in display order. */
	options: array(strictObject({
		value: string$1(),
		label: string$1().min(1)
	})).min(1).optional(),
	group: _enum(CONNECTION_FIELD_GROUPS).optional(),
	secret: boolean().optional()
});
/**
* How a connection URL maps onto the form's fields (decision 055), so the host parses and writes
* one without running plugin code. `parts` names the field each piece of the URL fills; a query
* parameter fills `key`, its value translated through `values` (compared case-insensitively) when
* given, so a value outside them is reported as ignored.
*/
var connectionUrlSchema = strictObject({
	/** Without `://`; the first is the one the host writes. */
	schemes: array(string$1().regex(/^[a-z][a-z0-9+.-]*$/, { message: "expected a lower-case URL scheme" })).min(1),
	form: _enum(["server", "file"]),
	parts: partialRecord(_enum([
		"host",
		"port",
		"database",
		"user",
		"password",
		"path"
	]), string$1().regex(FIELD_KEY)),
	params: array(strictObject({
		name: string$1().min(1),
		key: string$1().regex(FIELD_KEY),
		values: record(string$1(), string$1()).optional()
	})).optional()
});
/**
* Which fields hold the server's address (decision 070), so the host can open an SSH tunnel and
* hand the plugin `127.0.0.1` and the forwarded port instead. `connectTimeout`, in seconds, bounds
* the SSH hop too. Absent: the data source is not reached over the network and offers no tunnel.
*/
var networkSpecSchema = strictObject({
	host: string$1().regex(FIELD_KEY),
	port: string$1().regex(FIELD_KEY),
	connectTimeout: string$1().regex(FIELD_KEY).optional()
});
var NETWORK_FIELD_KINDS = {
	host: "text",
	port: "number",
	connectTimeout: "number"
};
function networkFieldsDeclared(connection) {
	const network = connection.network;
	if (network === void 0) return true;
	return Object.keys(NETWORK_FIELD_KINDS).every((role) => {
		const key = network[role];
		if (key === void 0) return true;
		return connection.fields.some((field) => field.key === key && field.kind === NETWORK_FIELD_KINDS[role]);
	});
}
/**
* Which fields configure TLS (decision 072), so the dialog groups them under SSL, hints when a CA
* file goes unchecked, and main asks for the key passphrase only when the key file is encrypted.
* `mode` is the `select` of SSL modes; `verifyModes` are its values that check the server
* certificate. Absent: the plugin speaks no TLS the host knows about.
*/
var tlsSpecSchema = strictObject({
	mode: string$1().regex(FIELD_KEY),
	verifyModes: array(string$1().min(1)).min(1),
	caFile: string$1().regex(FIELD_KEY).optional(),
	certFile: string$1().regex(FIELD_KEY).optional(),
	keyFile: string$1().regex(FIELD_KEY).optional(),
	keyPassphrase: string$1().regex(FIELD_KEY).optional()
});
/** The roles of `TlsSpec` that name a field, in the order the dialog draws them. */
var TLS_FIELD_ROLES = [
	"mode",
	"caFile",
	"certFile",
	"keyFile",
	"keyPassphrase"
];
function tlsFieldFits(role, field, tls) {
	switch (role) {
		case "mode": {
			const values = new Set((field.options ?? []).map((option) => option.value));
			return field.kind === "select" && tls.verifyModes.every((mode) => values.has(mode));
		}
		case "keyPassphrase": return field.kind === "password" && field.secret === true;
		default: return field.kind === "file";
	}
}
function tlsFieldsDeclared(connection) {
	const tls = connection.tls;
	if (tls === void 0) return true;
	return TLS_FIELD_ROLES.every((role) => {
		const key = tls[role];
		if (key === void 0) return true;
		const field = connection.fields.find((candidate) => candidate.key === key);
		return field !== void 0 && tlsFieldFits(role, field, tls);
	});
}
strictObject({
	id: string$1().regex(PLUGIN_ID$1, { message: "expected lower-case letters, digits and dashes" }),
	name: string$1().min(1),
	version: semver,
	apiVersion: semver,
	/** An ES module, relative to the manifest, whose default export is the `DatasourcePlugin`. */
	entry: string$1().min(1),
	capabilities: array(_enum(CAPABILITIES$1)),
	/** The highlighter the console uses for this plugin's dialect (decision 008). */
	highlight: string$1().min(1),
	/** The connection form, readable without running plugin code (decision 019). */
	connection: strictObject({
		fields: array(connectionFieldSchema).min(1),
		/** Absent: the form offers no URL to paste and the data source no Copy as URL. */
		url: connectionUrlSchema.optional(),
		network: networkSpecSchema.optional(),
		tls: tlsSpecSchema.optional()
	}).refine(networkFieldsDeclared, {
		message: "network names a field the form does not declare, or one of the wrong kind",
		path: ["network"]
	}).refine(tlsFieldsDeclared, {
		message: "tls names a field the form does not declare or one of the wrong kind: mode a select offering every verify mode, files of kind file, the passphrase a secret password",
		path: ["tls"]
	})
}).refine((manifest) => !manifest.capabilities.includes("ddl") || manifest.capabilities.includes("schemaTree"), {
	message: "the ddl capability requires schemaTree",
	path: ["capabilities"]
}).refine((manifest) => !manifest.capabilities.includes("explain") || manifest.capabilities.includes("sql"), {
	message: "the explain capability requires sql",
	path: ["capabilities"]
}).refine((manifest) => !manifest.capabilities.includes("explainAnalyze") || manifest.capabilities.includes("explain"), {
	message: "the explainAnalyze capability requires explain",
	path: ["capabilities"]
}).refine((manifest) => !manifest.capabilities.includes("currentNamespace") || manifest.capabilities.includes("sql"), {
	message: "the currentNamespace capability requires sql",
	path: ["capabilities"]
}).refine((manifest) => !manifest.capabilities.includes("bulkInsert") || manifest.capabilities.includes("transactions"), {
	message: "the bulkInsert capability requires transactions",
	path: ["capabilities"]
}).refine((manifest) => !manifest.capabilities.includes("objects") || manifest.capabilities.includes("sql") && manifest.capabilities.includes("schemaTree"), {
	message: "the objects capability requires sql and schemaTree",
	path: ["capabilities"]
}).refine((manifest) => !manifest.capabilities.includes("sessions") || manifest.capabilities.includes("sql") && manifest.capabilities.includes("schemaTree"), {
	message: "the sessions capability requires sql and schemaTree",
	path: ["capabilities"]
}).refine((manifest) => !manifest.capabilities.includes("routineCall") || manifest.capabilities.includes("sql") && manifest.capabilities.includes("schemaTree"), {
	message: "the routineCall capability requires sql and schemaTree",
	path: ["capabilities"]
});
// ../plugin-api/src/tls.ts
/**
* Wording for TLS failures shared by the network plugins (decision 072). Pure: each plugin reads
* its files and drives its own driver, and hands the error here to say what did not match.
*/
/** Node's codes for a server certificate whose chain the trusted CAs do not vouch for. */
var TLS_CHAIN_CODES = [
	"UNABLE_TO_VERIFY_LEAF_SIGNATURE",
	"UNABLE_TO_GET_ISSUER_CERT",
	"UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
	"SELF_SIGNED_CERT_IN_CHAIN",
	"DEPTH_ZERO_SELF_SIGNED_CERT",
	"CERT_SIGNATURE_FAILURE",
	"CERT_UNTRUSTED"
];
/** Node's codes for a server certificate outside its validity dates. */
var TLS_DATE_CODES = ["CERT_HAS_EXPIRED", "CERT_NOT_YET_VALID"];
[...TLS_CHAIN_CODES, ...TLS_DATE_CODES];
var HEX_RADIX = 16;
var HEX_BYTE_WIDTH = 2;
var HEX_DIGITS = Array.from({ length: 256 }, (_, byte) => byte.toString(HEX_RADIX).padStart(HEX_BYTE_WIDTH, "0"));
function toHex(bytes) {
	const digits = new Array(bytes.byteLength);
	for (let index = 0; index < bytes.byteLength; index += 1) digits[index] = HEX_DIGITS[bytes[index] ?? 0] ?? "";
	return digits.join("");
}
/** A binary value as it crosses the wire: the preview, or every byte with `fullBytes`. */
function toBytesValue(bytes, options = {}) {
	return {
		kind: "bytes",
		preview: toHex(options.fullBytes === true ? bytes : bytes.subarray(0, 32)),
		length: bytes.byteLength
	};
}
/** A 64-bit integer as a number when it is exact in a double, tagged otherwise. */
function toWireInteger(value) {
	const exact = BigInt(value);
	if (exact >= BigInt(Number.MIN_SAFE_INTEGER) && exact <= BigInt(Number.MAX_SAFE_INTEGER)) return Number(exact);
	return {
		kind: "bigint",
		value: exact.toString()
	};
}
/** Converts what a JavaScript driver typically returns into a `WireValue`. */
function toWireValue(value, options = {}) {
	if (value === null || value === void 0) return null;
	switch (typeof value) {
		case "boolean":
		case "number":
		case "string": return value;
		case "bigint": return {
			kind: "bigint",
			value: value.toString()
		};
	}
	if (value instanceof Uint8Array) return toBytesValue(value, options);
	if (value instanceof Date) return {
		kind: "date",
		iso: value.toISOString()
	};
	return {
		kind: "json",
		text: JSON.stringify(value)
	};
}
// ../plugin-api/src/sql/functions.ts
var RETURNS_ARROW = "->";
var SHOWN_ARROW = "→";
var OPTIONAL_MARK = "?";
var VARIADIC_MARK = "...";
var COMPARATOR = /^(>=|<=|>|<|=)?(\d+(?:\.\d+)*)$/;
function parameter$1(written) {
	let name = written.trim();
	const variadic = name.endsWith(VARIADIC_MARK);
	if (variadic) name = name.slice(0, -3).trim();
	const optional = name.endsWith(OPTIONAL_MARK);
	if (optional) name = name.slice(0, -1).trim();
	return {
		name,
		...optional ? { optional } : {},
		...variadic ? { variadic } : {}
	};
}
/** Reads `"str, len? -> string"`: `?` marks an optional parameter, `...` one that repeats. */
function parseSignature(written) {
	const arrow = written.lastIndexOf(RETURNS_ARROW);
	if (arrow < 0) throw new Error(`Signature "${written}" has no "${RETURNS_ARROW} type"; add what it returns.`);
	const list = written.slice(0, arrow).trim();
	return {
		parameters: list === "" ? [] : list.split(",").map(parameter$1),
		returns: written.slice(arrow + 2).trim()
	};
}
/** Specs for one category, from compact entries a plugin's data file lists. */
function functionSpecs(category, entries) {
	return entries.map(([name, signatures, summary, available]) => ({
		name,
		signatures: (typeof signatures === "string" ? [signatures] : signatures).map(parseSignature),
		summary,
		category,
		...available === void 0 ? {} : { available }
	}));
}
function compareVersions(left, right) {
	for (let at = 0; at < Math.max(left.length, right.length); at += 1) {
		const difference = (left[at] ?? 0) - (right[at] ?? 0);
		if (difference !== 0) return difference;
	}
	return 0;
}
function satisfies(version, comparator) {
	const match = COMPARATOR.exec(comparator);
	if (match === null) throw new Error(`Version comparator "${comparator}" is not like ">=8.0.4"; fix the range.`);
	const order = compareVersions(version, (match[2] ?? "").split(".").map(Number));
	switch (match[1]) {
		case ">=": return order >= 0;
		case "<=": return order <= 0;
		case ">": return order > 0;
		case "<": return order < 0;
		default: return order === 0;
	}
}
/** Whether `spec` exists on `server`; an unknown server has every function any flavour has. */
function isAvailable(spec, server) {
	if (spec.available === void 0 || server === null) return true;
	const range = spec.available[server.flavour];
	if (range === void 0) return true;
	if (range === false) return false;
	return range.split(/\s+/).filter((comparator) => comparator !== "").every((comparator) => satisfies(server.version, comparator));
}
function shownParameter(parameter) {
	const name = parameter.variadic === true ? `${parameter.name}${VARIADIC_MARK}` : parameter.name;
	return parameter.optional === true ? `[${name}]` : name;
}
/** `(date, format) → string`, the popup's detail for one signature. */
function signatureLabel(signature) {
	return `(${signature.parameters.map(shownParameter).join(", ")}) ${SHOWN_ARROW} ${signature.returns}`;
}
/** Every signature on its own line, then the summary. */
function functionInfo(spec) {
	const label = spec.name.toLowerCase();
	return `${spec.signatures.map((signature) => `${label}${signatureLabel(signature)}`).join("\n")}\n\n${spec.summary}`;
}
/** A spec as an item: `name()` with the caret between the parentheses when it takes arguments. */
function functionItem(spec, boost) {
	if (typeof spec === "string") return {
		label: spec,
		kind: "function",
		detail: null,
		apply: spec,
		boost,
		info: null,
		caret: null
	};
	const label = spec.name.toLowerCase();
	const first = spec.signatures[0];
	const takesArguments = spec.signatures.some((signature) => signature.parameters.length > 0);
	return {
		label,
		kind: "function",
		detail: first === void 0 ? null : signatureLabel(first),
		apply: `${label}()`,
		boost,
		info: functionInfo(spec),
		caret: takesArguments ? label.length + 1 : null
	};
}
/** The name a function entry is offered under, either form. */
function functionName(spec) {
	return typeof spec === "string" ? spec : spec.name;
}
/** Aggregate and scalar functions every built-in dialect has; a plugin adds its own. Written in our own words. */
var SQL_FUNCTIONS = [
	...functionSpecs("aggregate", [
		[
			"AVG",
			"expr -> number",
			"The mean of the non-null values in the group."
		],
		[
			"COUNT",
			["* -> integer", "expr -> integer"],
			"How many rows the group has, or how many give a non-null value."
		],
		[
			"MAX",
			"expr -> value",
			"The largest value in the group."
		],
		[
			"MIN",
			"expr -> value",
			"The smallest value in the group."
		],
		[
			"SUM",
			"expr -> number",
			"The total of the values in the group."
		]
	]),
	...functionSpecs("numeric", [[
		"ABS",
		"x -> number",
		"The value without its sign."
	], [
		"ROUND",
		"x, digits? -> number",
		"Rounds to the given number of decimal places, zero by default."
	]]),
	...functionSpecs("string", [
		[
			"LENGTH",
			"str -> integer",
			"How long the string is."
		],
		[
			"LOWER",
			"str -> string",
			"The string in lower case."
		],
		[
			"REPLACE",
			"str, from, to -> string",
			"Swaps every occurrence of one substring for another."
		],
		[
			"SUBSTR",
			"str, start, length? -> string",
			"Part of the string from a 1-based position, optionally of a set length."
		],
		[
			"TRIM",
			"str -> string",
			"The string without spaces at either end."
		],
		[
			"UPPER",
			"str -> string",
			"The string in upper case."
		]
	]),
	...functionSpecs("control", [
		[
			"CAST",
			"expr AS type -> value",
			"Converts a value to another type."
		],
		[
			"COALESCE",
			"value... -> value",
			"The first argument that is not null."
		],
		[
			"NULLIF",
			"a, b -> value",
			"Null when both arguments are equal, else the first."
		]
	])
];
var NEWLINE$1 = "\n";
var FIRST_NON_ASCII = 128;
var DOLLAR_TAG = /\$(?:[A-Za-z_\u0080-\uffff][A-Za-z0-9_\u0080-\uffff]*)?\$/y;
/** PostgreSQL's `E'…'` string, where backslashes escape whatever the dialect's default. */
var ESCAPE_STRING_PREFIX = /^[eE]$/;
function isSpace(char) {
	return char === " " || char === "	" || char === "\n" || char === "\r" || char === "\f" || char === "\v";
}
function isWordChar(char) {
	if (char.charCodeAt(0) >= FIRST_NON_ASCII) return true;
	return char >= "a" && char <= "z" || char >= "A" && char <= "Z" || char >= "0" && char <= "9" || char === "_" || char === "$";
}
/** A hand-written scanner: it knows quoting and comments, never grammar, so it cannot reject a statement. */
var Lexer = class {
	text;
	options;
	position = 0;
	constructor(text, options) {
		this.text = text;
		this.options = options;
	}
	/** The next token after whitespace, or null at the end. `delimiter` ends a statement wherever it starts outside quotes. */
	next(delimiter = ";") {
		const text = this.text;
		let at = this.position;
		while (at < text.length && isSpace(text.charAt(at))) at += 1;
		if (at >= text.length) {
			this.position = at;
			return null;
		}
		const char = text.charAt(at);
		const following = text.charAt(at + 1);
		let token;
		if (char === "-" && following === "-") token = this.#lineComment(at);
		else if (char === "#" && this.options.hashComments === true) token = this.#lineComment(at);
		else if (char === "/" && following === "*") token = this.#blockComment(at);
		else if (text.startsWith(delimiter, at)) token = {
			kind: "delimiter",
			from: at,
			to: at + delimiter.length
		};
		else if (char === "'") token = this.#quoted(at, "'", "string", this.options.backslashEscapes === true);
		else if (char === "\"") token = this.#quoted(at, "\"", "quoted", this.options.backslashEscapes === true);
		else if (char === "`") token = this.#quoted(at, "`", "quoted", false);
		else if (char === "$" && this.options.dollarQuotes === true && this.#dollarTag(at) !== null) token = this.#dollarQuoted(at, this.#dollarTag(at) ?? "");
		else if (isWordChar(char)) token = this.#word(at, delimiter);
		else token = {
			kind: "symbol",
			from: at,
			to: at + 1
		};
		this.position = token.to;
		return token;
	}
	#lineComment(from) {
		const end = this.text.indexOf(NEWLINE$1, from);
		return {
			kind: "comment",
			from,
			to: end < 0 ? this.text.length : end
		};
	}
	#blockComment(from) {
		const text = this.text;
		const nested = this.options.nestedBlockComments === true;
		let depth = 1;
		let at = from + 2;
		while (at < text.length && depth > 0) if (text.startsWith("*/", at)) {
			depth -= 1;
			at += 2;
		} else if (nested && text.startsWith("/*", at)) {
			depth += 1;
			at += 2;
		} else at += 1;
		return {
			kind: "comment",
			from,
			to: Math.min(at, text.length)
		};
	}
	/** A doubled quote is the quote itself; an unterminated one runs to the end of the text. */
	#quoted(from, quote, kind, backslashEscapes) {
		const text = this.text;
		let at = from + 1;
		while (at < text.length) {
			const char = text.charAt(at);
			if (backslashEscapes && char === "\\") at += 2;
			else if (char === quote) {
				if (text.charAt(at + 1) !== quote) return {
					kind,
					from,
					to: at + 1
				};
				at += 2;
			} else at += 1;
		}
		return {
			kind,
			from,
			to: text.length
		};
	}
	#dollarTag(at) {
		if (at > 0 && isWordChar(this.text.charAt(at - 1))) return null;
		DOLLAR_TAG.lastIndex = at;
		return DOLLAR_TAG.exec(this.text)?.[0] ?? null;
	}
	#dollarQuoted(from, tag) {
		const end = this.text.indexOf(tag, from + tag.length);
		return {
			kind: "string",
			from,
			to: end < 0 ? this.text.length : end + tag.length
		};
	}
	#word(from, delimiter) {
		const text = this.text;
		const customDelimiter = delimiter !== ";";
		let at = from;
		while (at < text.length && isWordChar(text.charAt(at))) {
			if (customDelimiter && at > from && text.startsWith(delimiter, at)) break;
			at += 1;
		}
		if (text.charAt(at) === "'" && ESCAPE_STRING_PREFIX.test(text.slice(from, at))) return {
			kind: "string",
			from,
			to: this.#quoted(at, "'", "string", true).to
		};
		return {
			kind: "word",
			from,
			to: at
		};
	}
};
/** Every token of `text` but comments, as one dialect reads it. */
function significantTokens(text, options) {
	const lexer = new Lexer(text, options);
	const tokens = [];
	for (let token = lexer.next(); token !== null; token = lexer.next()) if (token.kind !== "comment") tokens.push(token);
	return tokens;
}
function wordOf(text, token) {
	return text.slice(token.from, token.to).toUpperCase();
}
// ../plugin-api/src/sql/scope.ts
var OPEN$2 = "(";
var CLOSE$2 = ")";
var DOT$2 = ".";
var COMMA$4 = ",";
var NO_GROUP = -1;
var QUERY_STARTS$1 = /* @__PURE__ */ new Set(["SELECT", "WITH"]);
var RELATION_INTRODUCERS = /* @__PURE__ */ new Set([
	"FROM",
	"JOIN",
	"UPDATE",
	"INTO",
	"STRAIGHT_JOIN"
]);
var RELATION_MODIFIERS = /* @__PURE__ */ new Set(["LATERAL", "ONLY"]);
var EXPRESSION_CLAUSES = /* @__PURE__ */ new Set([
	"SELECT",
	"WHERE",
	"ON",
	"BY",
	"HAVING",
	"SET",
	"RETURNING",
	"USING"
]);
/** Clause keywords that end a FROM list; ON and USING belong to a join inside it. */
var FROM_LIST_ENDS = /* @__PURE__ */ new Set([
	"SELECT",
	"WHERE",
	"GROUP",
	"ORDER",
	"HAVING",
	"LIMIT",
	"OFFSET",
	"SET",
	"VALUES",
	"UNION",
	"INTERSECT",
	"EXCEPT",
	"RETURNING",
	"WINDOW",
	"FETCH",
	"FOR"
]);
var SELECT_LIST_ENDS = /* @__PURE__ */ new Set([
	...FROM_LIST_ENDS,
	"FROM",
	"INTO"
]);
var CLAUSE_WORDS = /* @__PURE__ */ new Set([
	...FROM_LIST_ENDS,
	...RELATION_INTRODUCERS,
	...EXPRESSION_CLAUSES,
	"DELETE",
	"INSERT"
]);
/** Words that end a table reference instead of naming or aliasing it. */
var NOT_A_NAME$1 = /* @__PURE__ */ new Set([
	...CLAUSE_WORDS,
	"AS",
	"INNER",
	"LEFT",
	"RIGHT",
	"FULL",
	"OUTER",
	"CROSS",
	"NATURAL",
	"LATERAL",
	"USE",
	"FORCE",
	"IGNORE",
	"WITH",
	"DEFAULT",
	"TABLESAMPLE",
	"WHEN",
	"THEN",
	"ELSE",
	"END",
	"AND",
	"OR",
	"NOT",
	"DISTINCT",
	"ALL",
	"CASE",
	"NULL"
]);
var AS$2 = "AS";
var WITH$3 = "WITH";
var RECURSIVE = "RECURSIVE";
var CTE_MODIFIERS = /* @__PURE__ */ new Set(["NOT", "MATERIALIZED"]);
var SELECT_MODIFIERS$1 = /* @__PURE__ */ new Set(["DISTINCT", "ALL"]);
var STAR$1 = "*";
var DIGIT = /^[0-9]/;
var BLOCK_COMMENT_END$1 = "*/";
var LINE_COMMENT_STARTS = ["--", "#"];
function unquote(raw) {
	const quote = raw.charAt(0);
	return (raw.length >= 2 && raw.endsWith(quote) ? raw.slice(1, -1) : raw.slice(1)).replaceAll(quote + quote, quote);
}
/** Whether the caret at `offset` sits inside a string or comment token. */
function insideLiteral(text, token, offset) {
	if (token.kind !== "string" && token.kind !== "comment") return false;
	if (offset <= token.from || offset > token.to) return false;
	if (offset < token.to) return true;
	const raw = text.slice(token.from, token.to);
	if (token.kind === "comment") return LINE_COMMENT_STARTS.some((start) => raw.startsWith(start)) || !raw.endsWith(BLOCK_COMMENT_END$1);
	const quote = raw.charAt(0);
	return raw.length < 2 || !raw.endsWith(quote);
}
/** The tokens of one statement, its parentheses matched, read for the queries in it. */
var Statement = class {
	#text;
	tokens;
	/** For each `(`, the index of its `)`, or the token count when it is never closed. */
	#close = /* @__PURE__ */ new Map();
	/** For each `(`, the `(` it sits in, or `NO_GROUP`. */
	#parent = /* @__PURE__ */ new Map();
	#queries = /* @__PURE__ */ new Map();
	constructor(text, tokens) {
		this.#text = text;
		this.tokens = tokens;
		const open = [];
		for (let index = 0; index < tokens.length; index += 1) {
			const symbol = this.#symbol(index);
			if (symbol === OPEN$2) {
				this.#parent.set(index, open.at(-1) ?? NO_GROUP);
				open.push(index);
			} else if (symbol === CLOSE$2) {
				const opened = open.pop();
				if (opened !== void 0) this.#close.set(opened, index);
			}
		}
		for (const opened of open) this.#close.set(opened, tokens.length);
	}
	#symbol(index) {
		const token = index === void 0 ? void 0 : this.tokens[index];
		return token?.kind === "symbol" ? this.#text.charAt(token.from) : null;
	}
	word(index) {
		const token = index === void 0 ? void 0 : this.tokens[index];
		return token?.kind === "word" ? this.#text.slice(token.from, token.to).toUpperCase() : null;
	}
	isSymbol(index, symbol) {
		return this.#symbol(index) === symbol;
	}
	/** A name, quoted or not, that no keyword claims. */
	identifier(index) {
		const token = index === void 0 ? void 0 : this.tokens[index];
		if (token === void 0) return null;
		const raw = this.#text.slice(token.from, token.to);
		if (token.kind === "quoted") return {
			name: unquote(raw),
			quoted: true,
			from: token.from,
			to: token.to
		};
		if (token.kind !== "word" || DIGIT.test(raw) || NOT_A_NAME$1.has(raw.toUpperCase())) return null;
		return {
			name: raw,
			quoted: false,
			from: token.from,
			to: token.to
		};
	}
	closeOf(open) {
		return open === NO_GROUP ? this.tokens.length : this.#close.get(open) ?? this.tokens.length;
	}
	/** The token indices directly inside `open`, a nested group standing as its `(`. */
	level(open) {
		const indices = [];
		const end = this.closeOf(open);
		for (let index = open + 1; index < end; index += 1) {
			indices.push(index);
			if (this.isSymbol(index, OPEN$2)) index = this.closeOf(index);
		}
		return indices;
	}
	isQuery(open) {
		if (open === NO_GROUP) return true;
		const first = this.word(open + 1);
		return first !== null && QUERY_STARTS$1.has(first) && open + 1 < this.closeOf(open);
	}
	/** The innermost group holding `offset`, by text position. */
	groupAt(offset) {
		let found = NO_GROUP;
		for (const [open, close] of this.#close) {
			const opened = this.tokens[open];
			const closed = this.tokens[close];
			if (opened === void 0 || opened.to > offset) continue;
			if (closed !== void 0 && closed.from < offset) continue;
			if (found === NO_GROUP || open > found) found = open;
		}
		return found;
	}
	enclosingQuery(open) {
		let group = open;
		while (!this.isQuery(group)) group = this.#parent.get(group) ?? NO_GROUP;
		return group;
	}
	/** Memoised before it is read, so a subquery naming its parent and the parent reading the subquery meet. */
	query(open) {
		const known = this.#queries.get(open);
		if (known !== void 0) return known;
		const query = {
			ctes: [],
			sources: [],
			select: [],
			insert: null,
			parent: null
		};
		this.#queries.set(open, query);
		query.parent = open === NO_GROUP ? null : this.query(this.enclosingQuery(this.#parent.get(open) ?? NO_GROUP));
		new QueryReader(this, open, query).read();
		return query;
	}
};
/** Reads one level's CTEs, sources and select list; anything it does not recognise it skips. */
var QueryReader = class {
	#statement;
	#query;
	#indices;
	#at = 0;
	constructor(statement, open, query) {
		this.#statement = statement;
		this.#query = query;
		this.#indices = statement.level(open);
	}
	#index(offset = 0) {
		return this.#indices[this.#at + offset];
	}
	read() {
		const statement = this.#statement;
		if (statement.word(this.#index()) === WITH$3) this.#readCtes();
		let expectRelation = false;
		let fromList = false;
		let into = false;
		let selecting = false;
		let selected = false;
		let item = [];
		const flush = () => {
			if (!selected) this.#selectItem(item);
			item = [];
		};
		for (; this.#at < this.#indices.length; this.#at += 1) {
			const index = this.#index();
			const word = statement.word(index);
			if (selecting) {
				if (word !== null && SELECT_LIST_ENDS.has(word)) {
					flush();
					selecting = false;
					selected = true;
				} else if (statement.isSymbol(index, COMMA$4)) {
					flush();
					continue;
				} else {
					if (!(item.length === 0 && word !== null && SELECT_MODIFIERS$1.has(word)) && index !== void 0) item.push(index);
					continue;
				}
			}
			if (word === "SELECT") {
				selecting = !selected;
				expectRelation = false;
				fromList = false;
				continue;
			}
			if (word !== null && RELATION_INTRODUCERS.has(word)) {
				expectRelation = true;
				into = word === "INTO";
				fromList = word !== "INTO";
				continue;
			}
			if (word !== null && CLAUSE_WORDS.has(word)) {
				expectRelation = false;
				if (FROM_LIST_ENDS.has(word)) fromList = false;
				continue;
			}
			if (expectRelation) {
				if (word !== null && RELATION_MODIFIERS.has(word)) continue;
				this.#readSource(into);
				expectRelation = false;
				into = false;
				continue;
			}
			if (fromList && statement.isSymbol(index, COMMA$4)) expectRelation = true;
		}
		if (selecting) flush();
	}
	#readCtes() {
		const statement = this.#statement;
		this.#at += 1;
		if (statement.word(this.#index()) === RECURSIVE) this.#at += 1;
		for (;;) {
			const name = statement.identifier(this.#index());
			if (name === null) return;
			this.#at += 1;
			let columns = null;
			const listOpen = this.#index();
			if (listOpen !== void 0 && statement.isSymbol(listOpen, OPEN$2)) {
				columns = statement.level(listOpen).map((index) => statement.identifier(index)).filter((identifier) => identifier !== null);
				this.#at += 1;
			}
			if (statement.word(this.#index()) === AS$2) this.#at += 1;
			while (CTE_MODIFIERS.has(statement.word(this.#index()) ?? "")) this.#at += 1;
			const body = this.#index();
			if (body === void 0 || !statement.isSymbol(body, OPEN$2)) return;
			this.#query.ctes.push({
				name,
				columns,
				query: statement.query(body)
			});
			this.#at += 1;
			if (!statement.isSymbol(this.#index(), COMMA$4)) return;
			this.#at += 1;
		}
	}
	/** Reads one table reference at the cursor and leaves the cursor on its last token. */
	#readSource(into) {
		const statement = this.#statement;
		const start = this.#index();
		if (start === void 0) return;
		const startToken = statement.tokens[start];
		if (startToken === void 0) return;
		if (statement.isSymbol(start, OPEN$2)) {
			const closeToken = statement.tokens[statement.closeOf(start)];
			const alias = this.#alias();
			this.#query.sources.push({
				kind: "derived",
				alias,
				query: statement.query(start),
				from: startToken.from,
				to: alias?.to ?? closeToken?.to ?? startToken.to
			});
			return;
		}
		const first = statement.identifier(start);
		if (first === null) {
			this.#at -= 1;
			return;
		}
		const parts = [first];
		while (statement.isSymbol(this.#index(1), DOT$2)) {
			const next = statement.identifier(this.#index(2));
			if (next === null) break;
			parts.push(next);
			this.#at += 2;
		}
		const name = parts.pop() ?? first;
		const following = this.#index(1);
		if (following !== void 0 && statement.isSymbol(following, OPEN$2)) {
			const source = {
				kind: "relation",
				qualifier: parts,
				name,
				alias: null,
				from: first.from,
				to: name.to
			};
			if (into) {
				const closeToken = statement.tokens[statement.closeOf(following)];
				const openToken = statement.tokens[following];
				this.#query.sources.push(source);
				this.#query.insert = {
					source,
					from: openToken?.to ?? name.to,
					to: closeToken?.from ?? Number.MAX_SAFE_INTEGER
				};
				this.#at += 1;
				return;
			}
			this.#at += 1;
		}
		const alias = this.#alias();
		this.#query.sources.push({
			kind: "relation",
			qualifier: parts,
			name,
			alias,
			from: first.from,
			to: alias?.to ?? name.to
		});
	}
	/** `[AS] alias` after the cursor; advances past it when present. */
	#alias() {
		const statement = this.#statement;
		const hasAs = statement.word(this.#index(1)) === AS$2;
		const alias = statement.identifier(this.#index(hasAs ? 2 : 1));
		if (alias !== null) this.#at += hasAs ? 2 : 1;
		else if (hasAs) this.#at += 1;
		return alias;
	}
	#selectItem(item) {
		const statement = this.#statement;
		const last = item.at(-1);
		if (last === void 0) return;
		if (statement.isSymbol(last, STAR$1)) {
			const qualified = item.length >= 3 && statement.isSymbol(item.at(-2), DOT$2);
			this.#query.select.push({
				kind: "star",
				qualifier: qualified ? statement.identifier(item.at(-3)) : null
			});
			return;
		}
		const name = statement.identifier(last);
		if (name !== null) this.#query.select.push({
			kind: "named",
			name
		});
	}
};
/** The statement around `offset` without its comments, and whether the caret sits in a string or comment. */
function statementTokens(text, offset, dialect) {
	const lexer = new Lexer(text, dialect);
	let tokens = [];
	let literal = false;
	for (let token = lexer.next(); token !== null; token = lexer.next()) {
		if (insideLiteral(text, token, offset)) literal = true;
		if (token.kind === "comment") continue;
		if (token.kind === "delimiter") {
			if (token.to <= offset) tokens = [];
			else if (token.from >= offset) break;
			continue;
		}
		tokens.push(token);
	}
	return {
		tokens,
		literal
	};
}
/** The name token the caret is in; completing needs a character before the caret, resolving does not. */
function wordIndexAt(tokens, offset, mode) {
	const index = tokens.findIndex((token) => (token.kind === "word" || token.kind === "quoted") && (mode === "complete" ? token.from < offset : token.from <= offset) && offset <= token.to);
	return index < 0 ? null : index;
}
/** `a.b.` written without spaces before the token at `index`, which starts at `end`. */
function qualifierBefore(statement, index, end) {
	const names = [];
	let at = index;
	let reach = end;
	for (;;) {
		const dot = statement.tokens[at - 1];
		const before = statement.identifier(at - 2);
		if (dot === void 0 || before === null || !statement.isSymbol(at - 1, DOT$2)) break;
		if (dot.to !== reach || before.to !== dot.from) break;
		names.unshift(before);
		reach = before.from;
		at -= 2;
	}
	return names;
}
function clauseOf(statement, queryOpen, group, anchor, query) {
	let clause = null;
	let fromList = false;
	let last = null;
	for (const index of statement.level(queryOpen)) {
		const token = statement.tokens[index];
		if (token === void 0 || token.from >= anchor) break;
		const word = statement.word(index);
		if (word !== null && CLAUSE_WORDS.has(word)) {
			clause = word;
			if (RELATION_INTRODUCERS.has(word) && word !== "INTO") fromList = true;
			else if (FROM_LIST_ENDS.has(word)) fromList = false;
		}
		last = index;
	}
	if (group !== queryOpen) {
		const insert = query.insert;
		if (insert !== null && insert.from <= anchor && anchor <= insert.to) return "insertColumns";
		return clause !== null && EXPRESSION_CLAUSES.has(clause) ? "columns" : "keywords";
	}
	const lastWord = statement.word(last ?? void 0);
	if (lastWord !== null && (RELATION_INTRODUCERS.has(lastWord) || RELATION_MODIFIERS.has(lastWord))) return lastWord === "JOIN" || lastWord === "STRAIGHT_JOIN" ? "join" : "relation";
	if (fromList && last !== null && statement.isSymbol(last, COMMA$4)) return "relation";
	if (clause !== null && EXPRESSION_CLAUSES.has(clause)) return "columns";
	return "keywords";
}
/**
* The statement around `offset` read as far as completion and navigation need (decision 028): the
* clause the caret is in, the qualifier before it, and the query level whose sources are in scope.
* It reads tokens, never a grammar, so it answers for half-typed SQL.
*/
function scopeAt(text, offset, dialect, mode = "complete") {
	const { tokens, literal } = statementTokens(text, offset, dialect);
	const statement = new Statement(text, tokens);
	const wordIndex = wordIndexAt(tokens, offset, mode);
	const wordToken = wordIndex === null ? void 0 : tokens[wordIndex];
	let word = null;
	if (wordToken !== void 0) {
		const raw = text.slice(wordToken.from, wordToken.to);
		word = wordToken.kind === "quoted" ? {
			name: unquote(raw),
			quoted: true,
			from: wordToken.from,
			to: wordToken.to
		} : {
			name: raw,
			quoted: false,
			from: wordToken.from,
			to: wordToken.to
		};
	}
	const prefixFrom = word?.from ?? offset;
	const following = tokens.findIndex((token) => token.from >= offset);
	const qualifier = qualifierBefore(statement, wordIndex ?? (following < 0 ? tokens.length : following), prefixFrom);
	const anchor = qualifier[0]?.from ?? prefixFrom;
	const dotAfter = wordIndex !== null && statement.isSymbol(wordIndex + 1, DOT$2) && tokens[wordIndex + 1]?.from === word?.to;
	const group = statement.groupAt(anchor);
	const queryOpen = statement.enclosingQuery(group);
	const query = statement.query(queryOpen);
	return {
		clause: literal ? "none" : clauseOf(statement, queryOpen, group, anchor, query),
		qualifier,
		prefixFrom,
		word,
		dotAfter,
		query
	};
}
// ../plugin-api/src/sql/signature.ts
/** Words a relation or routine name follows, so `TABLE upper (` defines rather than calls. */
var NAME_INTRODUCERS = /* @__PURE__ */ new Set([
	"CALL",
	"EXISTS",
	"FROM",
	"FUNCTION",
	"INDEX",
	"INTO",
	"JOIN",
	"KEY",
	"PROCEDURE",
	"REFERENCES",
	"TABLE",
	"TRIGGER",
	"UPDATE",
	"VIEW"
]);
var QUERY_STARTS = /* @__PURE__ */ new Set(["SELECT", "WITH"]);
function symbol(text, token, char) {
	return token?.kind === "symbol" && text.slice(token.from, token.to) === char;
}
function upperWord(text, token) {
	return token?.kind === "word" ? text.slice(token.from, token.to).toUpperCase() : null;
}
/**
* Finds the innermost call around `offset` whose name `known` accepts, counting its top-level
* commas; strings, comments and quoted names are tokens of their own, so their commas never count.
* Grouping parentheses are looked through; a subquery, a non-function name before `(` or a caret
* in a string or comment ends the search with null. `reserved` holds the dialect's keywords: a
* function spelled like one (`VALUES`, `LEFT`) is a call only where an operand fits, not after a
* name such as `INSERT INTO t VALUES (`.
*/
function callAt(text, offset, dialect, reserved, known) {
	const { tokens, literal } = statementTokens(text, offset, dialect);
	if (literal) return null;
	function callable(at) {
		const name = tokens[at];
		const word = upperWord(text, name);
		if (name === void 0 || word === null || !known(word)) return null;
		const before = tokens[at - 1];
		if (symbol(text, before, ".")) return null;
		const previous = upperWord(text, before);
		if (previous !== null && NAME_INTRODUCERS.has(previous)) return null;
		if (!reserved.has(word)) return name;
		return before === void 0 || before.kind === "symbol" && !symbol(text, before, ")") || previous !== null && reserved.has(previous) ? name : null;
	}
	const frames = [];
	let index = 0;
	for (; index < tokens.length; index += 1) {
		const token = tokens[index];
		if (token === void 0 || token.from >= offset) break;
		if (symbol(text, token, "(")) {
			const name = callable(index - 1);
			frames.push({
				name,
				named: name === null && !grouping(text, tokens[index - 1]),
				open: index,
				commas: 0
			});
		} else if (symbol(text, token, ")")) frames.pop();
		else if (symbol(text, token, ",")) {
			const top = frames.at(-1);
			if (top !== void 0) top.commas += 1;
		}
	}
	for (let depth = frames.length - 1; depth >= 0; depth -= 1) {
		const frame = frames[depth];
		if (frame === void 0) return null;
		if (frame.name === null) {
			if (frame.named || QUERY_STARTS.has(upperWord(text, tokens[frame.open + 1]) ?? "")) return null;
			continue;
		}
		return {
			name: text.slice(frame.name.from, frame.name.to),
			argument: frame.commas,
			from: frame.name.from,
			to: closeOf(text, tokens, index, frames.length - depth) ?? offset
		};
	}
	return null;
}
/** Whether a `(` after `before` only groups: it starts the statement or follows an operator or operand keyword. */
function grouping(text, before) {
	if (before === void 0) return true;
	if (before.kind === "symbol") return !symbol(text, before, ")");
	return GROUPING_WORDS.has(upperWord(text, before) ?? "");
}
/** Keywords an operand follows, so a `(` right after one groups an expression instead of naming a list. */
var GROUPING_WORDS = /* @__PURE__ */ new Set([
	"AND",
	"AS",
	"BETWEEN",
	"BY",
	"CASE",
	"DISTINCT",
	"ELSE",
	"HAVING",
	"IS",
	"LIKE",
	"NOT",
	"ON",
	"OR",
	"RETURN",
	"SELECT",
	"SET",
	"THEN",
	"WHEN",
	"WHERE",
	"XOR"
]);
/** The end of the `)` closing the call `levels` parentheses up from the caret, if the statement has one. */
function closeOf(text, tokens, from, levels) {
	let open = levels;
	for (let at = from; at < tokens.length; at += 1) {
		const token = tokens[at];
		if (symbol(text, token, "(")) open += 1;
		else if (symbol(text, token, ")")) {
			open -= 1;
			if (open === 0) return token?.to ?? null;
		}
	}
	return null;
}
// ../plugin-api/src/sql/select.ts
/** Why a statement is not a simple SELECT, for the console's toolbar (plan 026). */
var SELECT_READ_ONLY_REASONS = {
	notSelect: "the statement is not a simple SELECT",
	with: "the statement has a WITH clause",
	distinct: "the result is DISTINCT",
	joins: "the result joins two or more tables",
	aggregates: "the result aggregates rows",
	windows: "the result uses window functions",
	combines: "the result combines queries",
	derived: "the result reads a subquery or function, not a table",
	noTable: "the result reads no table"
};
var SELECT = "SELECT";
var FROM = "FROM";
var AS$1 = "AS";
var STAR = "*";
var DOT$1 = ".";
var COMMA$3 = ",";
var OPEN$1 = "(";
var CLOSE$1 = ")";
var OVER = "OVER";
var ONLY = "ONLY";
var ON = "ON";
var NOT = "NOT";
var WITH$2 = "WITH";
var DISTINCT = /* @__PURE__ */ new Set([
	"DISTINCT",
	"DISTINCTROW",
	"UNIQUE"
]);
var SELECT_ALL = "ALL";
/** What may follow the table at the top level. */
var TAIL_CLAUSES = /* @__PURE__ */ new Set([
	"WHERE",
	"ORDER",
	"LIMIT",
	"OFFSET",
	"FETCH"
]);
var JOINS = /* @__PURE__ */ new Set([
	"JOIN",
	"INNER",
	"LEFT",
	"RIGHT",
	"FULL",
	"CROSS",
	"NATURAL",
	"STRAIGHT_JOIN",
	"OUTER"
]);
var GROUPING = /* @__PURE__ */ new Set(["GROUP", "HAVING"]);
var SET_OPERATIONS = /* @__PURE__ */ new Set([
	"UNION",
	"INTERSECT",
	"EXCEPT",
	"MINUS"
]);
/** Top-level words after the table that make the statement more than a read of its rows. */
var OTHER_TAIL = /* @__PURE__ */ new Set([
	"WINDOW",
	"INTO",
	"FOR",
	"LOCK",
	"QUALIFY",
	"TABLESAMPLE",
	"PARTITION",
	"USE",
	"FORCE",
	"IGNORE",
	"INDEXED",
	"NOT"
]);
var AGGREGATES = /* @__PURE__ */ new Set([
	"COUNT",
	"SUM",
	"AVG",
	"MIN",
	"MAX",
	"ARRAY_AGG",
	"STRING_AGG",
	"GROUP_CONCAT",
	"JSON_AGG",
	"JSONB_AGG",
	"JSON_OBJECT_AGG",
	"JSONB_OBJECT_AGG",
	"JSON_ARRAYAGG",
	"JSON_OBJECTAGG",
	"JSON_GROUP_ARRAY",
	"JSON_GROUP_OBJECT",
	"BOOL_AND",
	"BOOL_OR",
	"EVERY",
	"BIT_AND",
	"BIT_OR",
	"BIT_XOR",
	"STDDEV",
	"STDDEV_POP",
	"STDDEV_SAMP",
	"VARIANCE",
	"VAR_POP",
	"VAR_SAMP",
	"TOTAL",
	"XMLAGG",
	"PERCENTILE_CONT",
	"PERCENTILE_DISC",
	"MODE"
]);
var NOT_A_NAME = /^[0-9$]/;
/** The text and kind checks the parser needs over one statement's tokens. */
var Reader = class {
	text;
	tokens;
	constructor(text, tokens) {
		this.text = text;
		this.tokens = tokens;
	}
	word(token) {
		return token?.kind === "word" ? wordOf(this.text, token) : null;
	}
	symbol(token) {
		return token?.kind === "symbol" ? this.text.slice(token.from, token.to) : null;
	}
	identifier(token) {
		if (token === void 0) return null;
		const raw = this.text.slice(token.from, token.to);
		if (token.kind === "quoted") return {
			name: unquote(raw),
			quoted: true,
			from: token.from,
			to: token.to
		};
		if (token.kind === "word" && !NOT_A_NAME.test(raw)) return {
			name: raw,
			quoted: false,
			from: token.from,
			to: token.to
		};
		return null;
	}
	/** Each token's parenthesis depth, and whether it sits inside a parenthesised subquery. */
	depths() {
		const depth = [];
		const inSubquery = [];
		const subqueries = [];
		this.tokens.forEach((token, index) => {
			const symbol = this.symbol(token);
			if (symbol === CLOSE$1) subqueries.pop();
			depth.push(subqueries.length);
			inSubquery.push(subqueries.some(Boolean));
			if (symbol === OPEN$1) subqueries.push(this.word(this.tokens[index + 1]) === SELECT);
		});
		return {
			depth,
			inSubquery
		};
	}
};
/** A dotted name `a.b.c` from `at`: its parts and the index after it, or null when `at` holds no name. */
function dottedName(reader, at) {
	const first = reader.identifier(reader.tokens[at]);
	if (first === null) return null;
	const parts = [first];
	let next = at + 1;
	while (reader.symbol(reader.tokens[next]) === DOT$1) {
		const part = reader.identifier(reader.tokens[next + 1]);
		if (part === null) break;
		parts.push(part);
		next += 2;
	}
	return {
		parts,
		next
	};
}
function selectItem(reader, from, to) {
	const tokens = reader.tokens;
	if (to - from === 1 && reader.symbol(tokens[from]) === STAR) return {
		kind: "star",
		qualifier: null
	};
	const name = dottedName(reader, from);
	if (name === null) return { kind: "expression" };
	if (name.next === to - 2 && reader.symbol(tokens[name.next]) === DOT$1 && reader.symbol(tokens[to - 1]) === STAR) return {
		kind: "star",
		qualifier: name.parts.at(-1) ?? null
	};
	const last = name.parts.at(-1);
	if (last === void 0) return { kind: "expression" };
	const column = () => ({
		kind: "column",
		qualifier: name.parts.slice(0, -1),
		name: last
	});
	if (name.next === to) return column();
	const aliasAt = reader.word(tokens[name.next]) === AS$1 ? name.next + 1 : name.next;
	if (aliasAt === to - 1 && (tokens[aliasAt]?.kind === "string" || reader.identifier(tokens[aliasAt]) !== null)) return column();
	return { kind: "expression" };
}
/** Why the select list makes the result something other than the table's rows, or null. */
function selectListRefusal(reader, from, to, inSubquery) {
	const tokens = reader.tokens;
	let aggregate = false;
	for (let at = from; at < to; at += 1) {
		if (inSubquery[at] === true) continue;
		const word = reader.word(tokens[at]);
		if (word === OVER) return SELECT_READ_ONLY_REASONS.windows;
		if (word !== null && AGGREGATES.has(word) && reader.symbol(tokens[at + 1]) === OPEN$1) aggregate = true;
	}
	return aggregate ? SELECT_READ_ONLY_REASONS.aggregates : null;
}
/** Why the words after the table refuse editing, or null when they only filter, order and limit. */
function tailRefusal(reader, from, depth) {
	const tokens = reader.tokens;
	const first = reader.word(tokens[from]);
	if (from < tokens.length && (first === null || !TAIL_CLAUSES.has(first))) {
		if (reader.symbol(tokens[from]) === COMMA$3 || first !== null && JOINS.has(first)) return SELECT_READ_ONLY_REASONS.joins;
		if (first !== null && GROUPING.has(first)) return SELECT_READ_ONLY_REASONS.aggregates;
		if (first !== null && SET_OPERATIONS.has(first)) return SELECT_READ_ONLY_REASONS.combines;
		return SELECT_READ_ONLY_REASONS.notSelect;
	}
	for (let at = from; at < tokens.length; at += 1) {
		if (depth[at] !== 0) continue;
		const word = reader.word(tokens[at]);
		if (word === null) continue;
		if (GROUPING.has(word)) return SELECT_READ_ONLY_REASONS.aggregates;
		if (SET_OPERATIONS.has(word)) return SELECT_READ_ONLY_REASONS.combines;
		if (JOINS.has(word) || word === ON && at > from) return SELECT_READ_ONLY_REASONS.joins;
		if (OTHER_TAIL.has(word) && word !== NOT) return SELECT_READ_ONLY_REASONS.notSelect;
	}
	return null;
}
/**
* `sql`, one statement, read as a single-table SELECT (plan 026). Strict on purpose: whatever
* it does not recognise is read-only, because a wrong "editable" writes to the wrong rows.
*/
function parseSimpleSelect(sql, dialect) {
	const tokens = significantTokens(sql, dialect).filter((token) => token.kind !== "delimiter");
	const reader = new Reader(sql, tokens);
	const head = reader.word(tokens[0]);
	if (head === WITH$2) return { readOnly: SELECT_READ_ONLY_REASONS.with };
	if (reader.symbol(tokens[0]) === OPEN$1) return { readOnly: SELECT_READ_ONLY_REASONS.combines };
	if (head !== SELECT) return { readOnly: SELECT_READ_ONLY_REASONS.notSelect };
	const { depth, inSubquery } = reader.depths();
	let at = 1;
	const modifier = reader.word(tokens[at]);
	if (modifier !== null && DISTINCT.has(modifier)) return { readOnly: SELECT_READ_ONLY_REASONS.distinct };
	if (modifier === SELECT_ALL) at += 1;
	const fromAt = tokens.findIndex((token, index) => index >= at && depth[index] === 0 && reader.word(token) === FROM);
	if (fromAt < 0) return { readOnly: SELECT_READ_ONLY_REASONS.noTable };
	const refusal = selectListRefusal(reader, at, fromAt, inSubquery);
	if (refusal !== null) return { readOnly: refusal };
	const items = [];
	let itemFrom = at;
	for (let index = at; index <= fromAt; index += 1) if (index === fromAt || depth[index] === 0 && reader.symbol(tokens[index]) === COMMA$3) {
		if (index === itemFrom) return { readOnly: SELECT_READ_ONLY_REASONS.notSelect };
		items.push(selectItem(reader, itemFrom, index));
		itemFrom = index + 1;
	}
	if (reader.symbol(tokens[fromAt + 1]) === OPEN$1) return { readOnly: SELECT_READ_ONLY_REASONS.derived };
	if (reader.word(tokens[fromAt + 1]) === ONLY) return { readOnly: SELECT_READ_ONLY_REASONS.notSelect };
	const table = dottedName(reader, fromAt + 1);
	if (table === null) return { readOnly: SELECT_READ_ONLY_REASONS.notSelect };
	if (reader.symbol(tokens[table.next]) === OPEN$1) return { readOnly: SELECT_READ_ONLY_REASONS.derived };
	let next = table.next;
	let alias = null;
	const afterTable = reader.word(tokens[next]);
	if (afterTable === AS$1) {
		alias = reader.identifier(tokens[next + 1]);
		if (alias === null) return { readOnly: SELECT_READ_ONLY_REASONS.notSelect };
		next += 2;
	} else if (tokens[next] !== void 0 && (afterTable === null || !isClauseWord(afterTable))) {
		alias = reader.identifier(tokens[next]);
		if (alias !== null) next += 1;
	}
	const tail = tailRefusal(reader, next, depth);
	if (tail !== null) return { readOnly: tail };
	const name = table.parts.at(-1);
	if (name === void 0) return { readOnly: SELECT_READ_ONLY_REASONS.notSelect };
	return {
		qualifier: table.parts.slice(0, -1),
		name,
		alias,
		items
	};
}
function isClauseWord(word) {
	return TAIL_CLAUSES.has(word) || JOINS.has(word) || GROUPING.has(word) || SET_OPERATIONS.has(word) || OTHER_TAIL.has(word) || word === ON || word === ONLY;
}
// ../plugin-api/src/sql/namespace.ts
var USE = "USE";
var SET = "SET";
var RESET = "RESET";
var SET_SCOPES = /* @__PURE__ */ new Set(["SESSION", "LOCAL"]);
var SEARCH_PATH = "SEARCH_PATH";
var SCHEMA = "SCHEMA";
var ALL = "ALL";
var ASSIGNMENTS = /* @__PURE__ */ new Set(["TO", "="]);
var DEFAULT = "DEFAULT";
var LIST_SEPARATOR = ",";
var STRING_QUOTE = "'";
var BLOCK_COMMENT_END = "*/";
function identifier$1(text, token) {
	if (token === void 0) return null;
	const raw = text.slice(token.from, token.to);
	const { from, to } = token;
	if (token.kind === "word") return {
		name: raw,
		quoted: false,
		from,
		to
	};
	if (token.kind === "quoted") return {
		name: unquote(raw),
		quoted: true,
		from,
		to
	};
	if (token.kind === "string" && raw.startsWith(STRING_QUOTE)) return {
		name: unquote(raw),
		quoted: true,
		from,
		to
	};
	return null;
}
function wordAt$1(text, tokens, at) {
	const token = tokens[at];
	if (token === void 0) return void 0;
	return token.kind === "word" || token.kind === "symbol" ? wordOf(text, token) : void 0;
}
function useTarget(text, tokens) {
	if (tokens.length !== 2 || wordAt$1(text, tokens, 0) !== USE) return null;
	const name = identifier$1(text, tokens[1]);
	return name === null || tokens[1]?.kind === "string" ? null : {
		kind: "database",
		candidates: [name]
	};
}
/** `a, "b", 'c'` from `at` to the end; null when it is not such a list. */
function list(text, tokens, at) {
	const names = [];
	for (let index = at; index < tokens.length; index += 2) {
		const name = identifier$1(text, tokens[index]);
		if (name === null) return null;
		names.push(name);
		const separator = tokens[index + 1];
		if (separator !== void 0 && wordAt$1(text, tokens, index + 1) !== LIST_SEPARATOR) return null;
		if (separator !== void 0 && index + 2 >= tokens.length) return null;
	}
	return names.length === 0 ? null : names;
}
function searchPathTarget(text, tokens) {
	const first = wordAt$1(text, tokens, 0);
	if (first === RESET) {
		const what = wordAt$1(text, tokens, 1);
		return tokens.length === 2 && (what === SEARCH_PATH || what === ALL) ? {
			kind: "schema",
			candidates: []
		} : null;
	}
	if (first !== SET) return null;
	let at = SET_SCOPES.has(wordAt$1(text, tokens, 1) ?? "") ? 2 : 1;
	const parameter = wordAt$1(text, tokens, at);
	at += 1;
	if (parameter === SEARCH_PATH) {
		if (!ASSIGNMENTS.has(wordAt$1(text, tokens, at) ?? "")) return null;
		at += 1;
	} else if (parameter !== SCHEMA) return null;
	if (tokens.length === at + 1 && tokens[at]?.kind === "word" && wordAt$1(text, tokens, at) === DEFAULT) return {
		kind: "schema",
		candidates: []
	};
	const names = list(text, tokens, at);
	if (names === null || parameter === SCHEMA && names.length !== 1) return null;
	return {
		kind: "schema",
		candidates: names
	};
}
var NAME_TOKENS = /* @__PURE__ */ new Set([
	"word",
	"quoted",
	"string"
]);
/** The statement's tokens around `offset`, comments dropped; null when the caret is in a comment. */
function tokensAround(text, offset, dialect) {
	const lexer = new Lexer(text, dialect);
	let tokens = [];
	for (let token = lexer.next(); token !== null; token = lexer.next()) {
		if (token.kind === "comment") {
			if (token.from < offset && offset < token.to) return null;
			if (offset === token.to && !text.slice(token.from, token.to).endsWith(BLOCK_COMMENT_END)) return null;
			continue;
		}
		if (token.kind === "delimiter") {
			if (token.to <= offset) tokens = [];
			else if (token.from >= offset) break;
			continue;
		}
		tokens.push(token);
	}
	return tokens;
}
function closes(raw) {
	return raw.length >= 2 && raw.endsWith(raw.charAt(0));
}
/** The names of `name , name ,` from `at` to the end; null when the tokens are not such a list. */
function listedBefore(text, tokens, at) {
	if ((tokens.length - at) % 2 !== 0) return null;
	const names = [];
	for (let index = at; index < tokens.length; index += 2) {
		const name = identifier$1(text, tokens[index]);
		if (name === null || wordAt$1(text, tokens, index + 1) !== LIST_SEPARATOR) return null;
		names.push(name);
	}
	return names;
}
function searchPathListStart(text, tokens) {
	if (wordAt$1(text, tokens, 0) !== SET) return null;
	let at = SET_SCOPES.has(wordAt$1(text, tokens, 1) ?? "") ? 2 : 1;
	const parameter = wordAt$1(text, tokens, at);
	at += 1;
	if (parameter === SCHEMA) return {
		at,
		single: true
	};
	if (parameter !== SEARCH_PATH || !ASSIGNMENTS.has(wordAt$1(text, tokens, at) ?? "")) return null;
	return {
		at: at + 1,
		single: false
	};
}
/**
* Where the caret at `offset` names a namespace a session-namespace statement of the dialect moves
* to: `USE |` or the elements of `SET search_path TO a, |` and `SET SCHEMA |`. Null anywhere else,
* and after a name whose closing quote is typed.
*/
function namespaceSlotAt(text, offset, dialect) {
	const forms = dialect.namespaceStatements ?? [];
	if (forms.length === 0) return null;
	const tokens = tokensAround(text, offset, dialect);
	if (tokens === null) return null;
	const touched = tokens.findIndex((token) => token.from < offset && offset <= token.to);
	const prefix = touched >= 0 && NAME_TOKENS.has(tokens[touched]?.kind ?? "symbol") ? tokens[touched] : void 0;
	const before = tokens.filter((token) => prefix === void 0 ? token.to <= offset : token.to <= prefix.from);
	let from = prefix?.from ?? offset;
	let quote = null;
	if (prefix !== void 0 && prefix.kind !== "word") {
		const raw = text.slice(prefix.from, prefix.to);
		const char = raw.charAt(0);
		if (prefix.kind === "string" && char !== STRING_QUOTE) return null;
		const closed = closes(raw);
		if (closed && offset === prefix.to) return null;
		quote = {
			char,
			closed
		};
		from = prefix.from + char.length;
	}
	for (const form of forms) {
		if (form === "use") {
			if (prefix?.kind === "string" || before.length !== 1 || wordAt$1(text, before, 0) !== USE) continue;
			return {
				kind: "database",
				from,
				to: offset,
				quote,
				listed: []
			};
		}
		const start = searchPathListStart(text, before);
		if (start === null) continue;
		if (start.single && before.length !== start.at) continue;
		const listed = listedBefore(text, before, start.at);
		if (listed !== null) return {
			kind: "schema",
			from,
			to: offset,
			quote,
			listed
		};
	}
	return null;
}
/**
* Whether `sql` is a statement that moves the session's current namespace in a dialect declaring
* `namespaceStatements`, and where it points. It never asks the server, so a named namespace may
* not exist; the session's `currentNamespace()` is the truth once the statement ran.
*/
function namespaceTarget(sql, dialect) {
	const forms = dialect.namespaceStatements ?? [];
	if (forms.length === 0) return null;
	const tokens = significantTokens(sql, dialect).filter((token) => token.kind !== "delimiter");
	for (const form of forms) {
		const target = form === "use" ? useTarget(sql, tokens) : searchPathTarget(sql, tokens);
		if (target !== null) return target;
	}
	return null;
}
// ../plugin-api/src/sql/splitter.ts
var DELIMITER_COMMAND$1 = "DELIMITER";
/** A body only opens inside a statement that defines a routine, so a column called `begin` stays a column. */
var BODY_OWNERS = /* @__PURE__ */ new Set([
	"TRIGGER",
	"FUNCTION",
	"PROCEDURE",
	"EVENT"
]);
var CREATE$1 = "CREATE";
var CASE$2 = "CASE";
var END$3 = "END";
/** `END IF`, `END LOOP` and the like close a construct the splitter never counted as opened. */
var UNCOUNTED_END_TARGETS = /* @__PURE__ */ new Set([
	"IF",
	"LOOP",
	"WHILE",
	"REPEAT"
]);
var LINE_BREAK$3 = /\r?\n/;
var NEWLINE = "\n";
/**
* A stream rescans its unfinished text only once it has doubled, so one statement spanning a
* thousand pushes is read a logarithmic number of times rather than once per push.
*/
var RESCAN_GROWTH = 2;
function freshStatement(from) {
	return {
		from,
		to: from,
		words: 0,
		isCreate: false,
		definesRoutine: false,
		depth: 0,
		pendingEnd: false
	};
}
function scanner(options) {
	const blockKeywords = new Set((options.blockKeywords ?? []).map((keyword) => keyword.toUpperCase()));
	return (text, startDelimiter, final) => {
		const spans = [];
		const lexer = new Lexer(text, options);
		let delimiter = startDelimiter;
		let statement = null;
		let checkpoint = {
			offset: 0,
			delimiter
		};
		const flush = (end) => {
			if (statement !== null) spans.push({
				from: statement.from,
				to: statement.to,
				sql: text.slice(statement.from, statement.to)
			});
			statement = null;
			checkpoint = {
				offset: end,
				delimiter
			};
		};
		const readDelimiterCommand = (token) => {
			const line = text.slice(token.to).split(LINE_BREAK$3, 1)[0] ?? "";
			const value = line.trim().split(/\s+/, 1)[0] ?? "";
			if (value !== "") delimiter = value;
			lexer.position = token.to + line.length;
			checkpoint = {
				offset: lexer.position,
				delimiter
			};
		};
		const resolvePendingEnd = (current, token) => {
			if (!current.pendingEnd) return false;
			current.pendingEnd = false;
			const word = token.kind === "word" ? wordOf(text, token) : "";
			if (UNCOUNTED_END_TARGETS.has(word)) return true;
			current.depth = Math.max(0, current.depth - 1);
			return word === CASE$2;
		};
		for (let token = lexer.next(delimiter); token !== null; token = lexer.next(delimiter)) {
			if (token.kind === "comment") continue;
			if (token.kind === "delimiter") {
				const current = statement;
				if (current !== null) resolvePendingEnd(current, token);
				if (current === null || current.depth === 0 || delimiter !== ";") flush(token.to);
				else current.to = token.to;
				continue;
			}
			if (statement === null) {
				if (options.delimiterCommand === true && token.kind === "word" && wordOf(text, token) === DELIMITER_COMMAND$1) {
					readDelimiterCommand(token);
					continue;
				}
				statement = freshStatement(token.from);
			}
			const current = statement;
			current.to = token.to;
			const consumed = resolvePendingEnd(current, token);
			if (token.kind !== "word" || consumed) continue;
			const word = wordOf(text, token);
			current.words += 1;
			if (current.words === 1) {
				current.isCreate = word === CREATE$1;
				continue;
			}
			if (current.depth > 0) {
				if (word === END$3) current.pendingEnd = true;
				else if (blockKeywords.has(word) || word === CASE$2) current.depth += 1;
			} else if (current.definesRoutine && blockKeywords.has(word)) current.depth = 1;
			else if (current.isCreate && BODY_OWNERS.has(word)) current.definesRoutine = true;
		}
		if (final) flush(text.length);
		return {
			spans,
			checkpoint
		};
	};
}
/**
* A configurable splitter plugins may build `SqlLanguage.split` on (decision 023). It tokenizes
* strings, quoted identifiers, comments, dollar quotes, `DELIMITER` lines and `BEGIN … END`
* bodies, and drops statements that hold nothing but comments.
*/
function sqlSplitter(options = {}) {
	const scan = scanner(options);
	return (text) => scan(text, ";", true).spans;
}
/**
* `sqlSplitter` over text that arrives in pieces, for `SqlLanguage.splitStream` (decision 081).
* Only whole lines are scanned before `end`, so a token, a `DELIMITER` line or a multi-character
* delimiter cut by a push is read once its line is complete. Statements come out exactly as
* `sqlSplitter` would find them in the concatenated text.
*/
function sqlStatementStream(options = {}) {
	const scan = scanner(options);
	return () => {
		let pending = "";
		/** Where `pending` starts in everything pushed, and the line and column there. */
		let base = 0;
		let line = 1;
		let column = 1;
		let delimiter = ";";
		let scannedLength = 0;
		const advance = (consumed) => {
			let lineStart = -1;
			for (let at = consumed.indexOf(NEWLINE); at >= 0; at = consumed.indexOf(NEWLINE, at + 1)) {
				line += 1;
				lineStart = at + 1;
			}
			column = lineStart < 0 ? column + consumed.length : consumed.length - lineStart + 1;
			base += consumed.length;
		};
		const located = (spans) => {
			const startLine = line;
			const startColumn = column;
			let cursor = 0;
			let cursorLine = startLine;
			let cursorColumn = startColumn;
			return spans.map((span) => {
				for (let at = pending.indexOf(NEWLINE, cursor); at >= 0 && at < span.from; at = pending.indexOf(NEWLINE, at + 1)) {
					cursorLine += 1;
					cursorColumn = 1;
					cursor = at + 1;
				}
				cursorColumn += span.from - cursor;
				cursor = span.from;
				return {
					from: base + span.from,
					to: base + span.to,
					sql: span.sql,
					line: cursorLine,
					column: cursorColumn
				};
			});
		};
		const run = (final) => {
			const scanned = final ? pending : pending.slice(0, pending.lastIndexOf(NEWLINE) + 1);
			if (scanned === "") return [];
			const { spans, checkpoint } = scan(scanned, delimiter, final);
			const statements = located(spans);
			const consumed = final ? pending.length : checkpoint.offset;
			advance(pending.slice(0, consumed));
			pending = pending.slice(consumed);
			delimiter = checkpoint.delimiter;
			scannedLength = pending.length;
			return statements;
		};
		return {
			push: (text) => {
				pending += text;
				if (pending.length < scannedLength * RESCAN_GROWTH) return [];
				return run(false);
			},
			end: () => {
				const statements = run(true);
				pending = "";
				return statements;
			}
		};
	};
}
// ../plugin-api/src/sql/complete.ts
/** Reserved words every built-in dialect shares; a plugin adds its own. */
var SQL_KEYWORDS = [
	"ALL",
	"AND",
	"AS",
	"ASC",
	"BETWEEN",
	"BY",
	"CASE",
	"CREATE",
	"CROSS",
	"DELETE",
	"DESC",
	"DISTINCT",
	"DROP",
	"ELSE",
	"END",
	"EXISTS",
	"FALSE",
	"FROM",
	"FULL",
	"GROUP",
	"HAVING",
	"IN",
	"INNER",
	"INSERT",
	"INTO",
	"IS",
	"JOIN",
	"LEFT",
	"LIKE",
	"LIMIT",
	"NOT",
	"NULL",
	"OFFSET",
	"ON",
	"OR",
	"ORDER",
	"OUTER",
	"RIGHT",
	"SELECT",
	"SET",
	"TABLE",
	"THEN",
	"TRUE",
	"UNION",
	"UPDATE",
	"USING",
	"VALUES",
	"WHEN",
	"WHERE",
	"WITH"
];
/** Ranks items the typed prefix matches equally well (plan 009 decision 12). */
var BOOST = {
	join: 50,
	column: 40,
	cte: 35,
	table: 30,
	view: 30,
	alias: 20,
	namespace: 10,
	function: 0,
	keyword: -10
};
/** CTEs that read each other stop expanding here, so a recursive one cannot loop. */
var MAX_EXPANSION_DEPTH = 4;
var UNQUOTED_WORD = "^[A-Za-z0-9_$]*$";
var ALIAS_WORD_BREAK = /[^A-Za-z0-9]+|(?<=[a-z0-9])(?=[A-Z])/;
var FALLBACK_ALIAS = "t";
var QUOTES = /* @__PURE__ */ new Set(["\"", "`"]);
/** Below every other namespace: `USE mysql` is legitimate but rarely meant. */
var SYSTEM_NAMESPACE_BOOST = -20;
var CURRENT_DETAIL = "current";
function samePath(left, right) {
	return left !== null && right !== null && left.length === right.length && left.every((part, at) => part === right[at]);
}
/** Whether `namespace` is one `target` can switch to (found live, plan 022). */
function targetable(target, namespace) {
	return switchableTo(target.kind === "database" ? "topLevel" : "schema", namespace);
}
function relationKind(relation) {
	return relation.kind === "table" ? "table" : "view";
}
/** The shared completion and navigation every built-in plugin spreads into its `SqlLanguage` (decision 028). */
function sqlCompleter(options) {
	const reserved = new Set(options.keywords.map((keyword) => keyword.toUpperCase()));
	const split = sqlSplitter(options.dialect);
	const specs = /* @__PURE__ */ new Map();
	for (const spec of options.functions) {
		if (typeof spec === "string") continue;
		const key = spec.name.toUpperCase();
		specs.set(key, [...specs.get(key) ?? [], spec]);
	}
	function serverOf(catalog) {
		const version = catalog.server.version;
		return version === null || options.server === void 0 ? null : options.server(version);
	}
	function specNamed(name, server) {
		return specs.get(name.toUpperCase())?.find((spec) => isAvailable(spec, server));
	}
	function fold(name) {
		switch (options.identifierFolding) {
			case "lower": return name.toLowerCase();
			case "upper": return name.toUpperCase();
			case "none": return name;
		}
	}
	/** Whether a name as written denotes `catalogName`: quoted exactly, unquoted folded, or case-blind where nothing folds. */
	function denotes(identifier, catalogName) {
		if (options.identifierFolding === "none") return identifier.name.toLowerCase() === catalogName.toLowerCase();
		return (identifier.quoted ? identifier.name : fold(identifier.name)) === catalogName;
	}
	function sameIdentifier(left, right) {
		const key = (identifier) => options.identifierFolding === "none" ? identifier.name.toLowerCase() : identifier.quoted ? identifier.name : fold(identifier.name);
		return key(left) === key(right);
	}
	function quoted(name) {
		return options.plainIdentifier.test(name) && !reserved.has(name.toUpperCase()) ? name : options.quoteIdentifier(name);
	}
	/** Every query level from the caret's outwards. */
	function levels(query) {
		const found = [];
		for (let level = query; level !== null; level = level.parent) found.push(level);
		return found;
	}
	function visibleCtes(query) {
		return levels(query).flatMap((level) => level.ctes);
	}
	function cteNamed(query, name) {
		return visibleCtes(query).find((cte) => sameIdentifier(cte.name, name));
	}
	/** The name a source is referred to by: its alias, else its relation's name. */
	function referenceName(source) {
		return source.alias ?? (source.kind === "relation" ? source.name : null);
	}
	function sourceNamed(query, name) {
		for (const level of levels(query)) {
			const source = level.sources.find((candidate) => {
				const reference = referenceName(candidate);
				return reference !== null && sameIdentifier(reference, name);
			});
			if (source !== void 0) return source;
		}
	}
	class Lookup {
		#catalog;
		#namespaces = null;
		#current;
		constructor(catalog) {
			this.#catalog = catalog;
			this.#current = catalog.current;
		}
		get server() {
			return serverOf(this.#catalog);
		}
		get current() {
			return this.#current;
		}
		/**
		* Makes the script's own namespace current: the nearest statement before `offset` that moves
		* the session's namespace, when one of its targets exists (plan 022 decision 7).
		*/
		async follow(text, offset) {
			const preceding = split(text).filter((span) => span.to < offset);
			for (let at = preceding.length - 1; at >= 0; at -= 1) {
				const span = preceding[at];
				const target = span === void 0 ? null : namespaceTarget(span.sql, options.dialect);
				if (target === null) continue;
				const namespaces = (await this.namespaces()).filter((namespace) => targetable(target, namespace));
				for (const candidate of target.candidates) {
					const found = namespaces.find((namespace) => denotes(candidate, namespace.path.at(-1) ?? ""));
					if (found !== void 0) {
						this.#current = found.path;
						return;
					}
				}
				return;
			}
		}
		namespaces() {
			this.#namespaces ??= this.#catalog.namespaces().catch(() => []);
			return this.#namespaces;
		}
		relations(path) {
			return this.#catalog.relations(path).catch(() => []);
		}
		referencing(path, relation) {
			return this.#catalog.referencing(path, relation).catch(() => []);
		}
		/** The namespace a qualifier names: its trailing path parts, as written. */
		async namespace(qualifier) {
			if (qualifier.length === 0) return void 0;
			const namespaces = await this.namespaces();
			const matches = (namespace) => {
				const tail = namespace.path.slice(-qualifier.length);
				return tail.length === qualifier.length && qualifier.every((part, at) => denotes(part, tail[at] ?? ""));
			};
			return namespaces.find((namespace) => matches(namespace) && !namespace.system) ?? namespaces.find(matches);
		}
		async relation(qualifier, name) {
			const path = qualifier.length === 0 ? this.current : (await this.namespace(qualifier))?.path ?? null;
			if (path === null) return null;
			const relations = await this.relations(path);
			const relation = relations.find((candidate) => candidate.name === name.name) ?? relations.find((candidate) => denotes(name, candidate.name));
			return relation === void 0 ? null : {
				path,
				relation
			};
		}
		async columnsOf(source, query, depth = 0) {
			if (source.kind === "derived") return this.selectColumns(source.query, depth + 1);
			if (source.qualifier.length === 0) {
				const cte = cteNamed(query, source.name);
				if (cte !== void 0) return this.cteColumns(cte, depth + 1);
			}
			return (await this.relation(source.qualifier, source.name))?.relation.columns.map((column) => ({
				name: column.name,
				type: column.type
			})) ?? [];
		}
		cteColumns(cte, depth) {
			if (cte.columns !== null) return Promise.resolve(cte.columns.map((column) => ({
				name: column.name,
				type: null
			})));
			return this.selectColumns(cte.query, depth);
		}
		/** A subquery's select list, `*` expanded through its own sources. */
		async selectColumns(query, depth) {
			if (depth > MAX_EXPANSION_DEPTH) return [];
			const columns = [];
			for (const item of query.select) {
				if (item.kind === "named") {
					columns.push({
						name: item.name.name,
						type: null
					});
					continue;
				}
				const sources = item.qualifier === null ? query.sources : query.sources.filter((source) => {
					const reference = referenceName(source);
					return reference !== null && item.qualifier !== null && sameIdentifier(reference, item.qualifier);
				});
				for (const source of sources) columns.push(...await this.columnsOf(source, query, depth));
			}
			return columns;
		}
	}
	function item(kind, label, apply, detail) {
		return {
			label,
			kind,
			detail,
			apply,
			boost: BOOST[kind],
			info: null,
			caret: null
		};
	}
	function relationItems(relations, namespace) {
		return relations.map((relation) => item(relationKind(relation), relation.name, quoted(relation.name), namespace));
	}
	function columnItems(columns) {
		const seen = /* @__PURE__ */ new Set();
		return columns.filter((column) => !seen.has(column.name) && seen.add(column.name)).map((column) => item("column", column.name, quoted(column.name), column.type));
	}
	function keywordItems(except = /* @__PURE__ */ new Set()) {
		return options.keywords.filter((keyword) => !except.has(keyword.toUpperCase())).map((keyword) => item("keyword", keyword, keyword, null));
	}
	function availableFunctions(server) {
		const offered = /* @__PURE__ */ new Set();
		return options.functions.filter((spec) => {
			const name = functionName(spec).toUpperCase();
			if (offered.has(name) || typeof spec !== "string" && !isAvailable(spec, server)) return false;
			offered.add(name);
			return true;
		});
	}
	async function qualifiedItems(scope, lookup) {
		const { qualifier, query, clause } = scope;
		const last = qualifier.at(-1);
		if (last === void 0) return [];
		const relational = clause === "relation" || clause === "join";
		if (qualifier.length === 1 && !relational) {
			const source = sourceNamed(query, last);
			if (source !== void 0) return columnItems(await lookup.columnsOf(source, query));
			const cte = cteNamed(query, last);
			if (cte !== void 0) return columnItems(await lookup.cteColumns(cte, 1));
		}
		const namespace = await lookup.namespace(qualifier);
		if (namespace !== void 0) return relationItems(await lookup.relations(namespace.path), null);
		if (relational) return [];
		const found = await lookup.relation(qualifier.slice(0, -1), last);
		return found === null ? [] : columnItems(found.relation.columns);
	}
	async function relationContextItems(scope, lookup) {
		const current = lookup.current;
		const namespaces = await lookup.namespaces();
		const currentName = namespaces.find((namespace) => samePath(namespace.path, current))?.name ?? null;
		const relations = current === null ? [] : await lookup.relations(current);
		const items = [
			...visibleCtes(scope.query).map((cte) => item("cte", cte.name.name, quoted(cte.name.name), null)),
			...relationItems(relations, currentName),
			...namespaces.filter((namespace) => !namespace.system && !samePath(namespace.path, current)).map((namespace) => item("namespace", namespace.name, quoted(namespace.name), namespace.kind))
		];
		if (scope.clause !== "join") return items;
		return [...await joinItems(scope, lookup), ...items];
	}
	function aliasFor(name, taken) {
		const initials = name.split(ALIAS_WORD_BREAK).filter((word) => word !== "").map((word) => word.charAt(0).toLowerCase()).join("");
		const base = initials === "" || !options.plainIdentifier.test(initials) ? FALLBACK_ALIAS : initials;
		let alias = base;
		for (let suffix = 1; taken.has(alias) || reserved.has(alias.toUpperCase()); suffix += 1) alias = `${base}${String(suffix)}`;
		taken.add(alias);
		return alias;
	}
	function relationReference(path, name, current) {
		const namespace = path.at(-1);
		return samePath(path, current) || namespace === void 0 ? quoted(name) : `${quoted(namespace)}.${quoted(name)}`;
	}
	/** `customers c ON c.id = o.customer_id` for each foreign key to or from a relation already in scope (plan 009 decision 7). */
	async function joinItems(scope, lookup) {
		const before = scope.query.sources.filter((source) => source.kind === "relation" && source.to <= scope.prefixFrom);
		const taken = new Set(scope.query.sources.map((source) => referenceName(source)).filter((name) => name !== null).map((name) => name.name.toLowerCase()));
		const items = [];
		const seen = /* @__PURE__ */ new Set();
		const add = (label, detail) => {
			if (seen.has(label)) return;
			seen.add(label);
			items.push(item("join", label, label, detail));
		};
		for (const source of before) {
			if (source.qualifier.length === 0 && cteNamed(scope.query, source.name) !== void 0) continue;
			const found = await lookup.relation(source.qualifier, source.name);
			if (found === null) continue;
			const near = source.alias === null ? relationReference(found.path, found.relation.name, lookup.current) : quoted(source.alias.name);
			for (const key of found.relation.foreignKeys) {
				const alias = aliasFor(key.target.relation, new Set(taken));
				const on = key.columns.map((column, at) => `${alias}.${quoted(key.target.columns[at] ?? column)} = ${near}.${quoted(column)}`).join(" AND ");
				add(`${relationReference(key.target.path, key.target.relation, lookup.current)} ${alias} ON ${on}`, key.name);
			}
			for (const incoming of await lookup.referencing(found.path, found.relation.name)) {
				const key = incoming.foreignKey;
				const alias = aliasFor(incoming.relation, new Set(taken));
				const on = key.columns.map((column, at) => `${alias}.${quoted(column)} = ${near}.${quoted(key.target.columns[at] ?? column)}`).join(" AND ");
				add(`${relationReference(incoming.path, incoming.relation, lookup.current)} ${alias} ON ${on}`, key.name);
			}
		}
		return items;
	}
	async function inScopeColumnItems(scope, lookup) {
		const { query } = scope;
		const perSource = await Promise.all(query.sources.map((source) => lookup.columnsOf(source, query)));
		const owners = /* @__PURE__ */ new Map();
		for (const columns of perSource) for (const name of new Set(columns.map((column) => column.name))) owners.set(name, (owners.get(name) ?? 0) + 1);
		const items = [];
		const seen = /* @__PURE__ */ new Set();
		query.sources.forEach((source, at) => {
			const reference = referenceName(source);
			for (const column of perSource[at] ?? []) {
				const shared = (owners.get(column.name) ?? 0) > 1 && reference !== null;
				const prefix = shared ? `${quoted(reference.name)}.` : "";
				const label = shared ? `${reference.name}.${column.name}` : column.name;
				if (seen.has(label)) continue;
				seen.add(label);
				items.push(item("column", label, `${prefix}${quoted(column.name)}`, column.type));
			}
		});
		const aliases = query.sources.filter((source) => source.alias !== null).map((source) => item("alias", source.alias?.name ?? "", quoted(source.alias?.name ?? ""), source.kind === "relation" ? source.name.name : null));
		const functions = availableFunctions(lookup.server);
		const functionNames = new Set(functions.map((spec) => functionName(spec).toUpperCase()));
		return [
			...items,
			...aliases,
			...functions.map((spec) => functionItem(spec, BOOST.function)),
			...keywordItems(functionNames)
		];
	}
	async function itemsFor(scope, lookup) {
		if (scope.clause === "none") return [];
		if (scope.qualifier.length > 0) return qualifiedItems(scope, lookup);
		switch (scope.clause) {
			case "relation":
			case "join": return relationContextItems(scope, lookup);
			case "columns": return inScopeColumnItems(scope, lookup);
			case "insertColumns": {
				const target = scope.query.insert?.source;
				const found = target === void 0 ? null : await lookup.relation(target.qualifier, target.name);
				return found === null ? [] : columnItems(found.relation.columns);
			}
			case "keywords": return keywordItems();
		}
	}
	/** Inside a quoted name every name is offered quoted, since the editor filters on what was typed. */
	function quotedLabels(items) {
		return items.map((entry) => entry.kind === "keyword" || entry.kind === "function" || entry.kind === "join" ? entry : {
			...entry,
			label: options.quoteIdentifier(entry.label)
		});
	}
	/** A clause body with `scope.relation` in scope reads as the WHERE of a `SELECT` from it. */
	function wrap(request) {
		if (request.scope === void 0) return {
			text: request.text,
			offset: request.offset,
			shift: 0
		};
		const { path, relation } = request.scope;
		const namespace = path.at(-1);
		const head = `SELECT * FROM ${namespace === void 0 ? options.quoteIdentifier(relation) : `${options.quoteIdentifier(namespace)}.${options.quoteIdentifier(relation)}`} WHERE `;
		return {
			text: head + request.text,
			offset: request.offset + head.length,
			shift: head.length
		};
	}
	/** Decision 2 and 3 of plan 029: what a `USE` or search path element can name, as the caret's quote needs it. */
	async function namespaceItems(slot, lookup) {
		const target = {
			kind: slot.kind,
			candidates: []
		};
		const namespaces = (await lookup.namespaces()).filter((namespace) => targetable(target, namespace) && !slot.listed.some((listed) => denotes(listed, namespace.path.at(-1) ?? namespace.name)));
		const ordered = [...namespaces.filter((namespace) => !namespace.system), ...namespaces.filter((namespace) => namespace.system)];
		const quote = slot.quote;
		return ordered.map((namespace) => {
			const name = namespace.path.at(-1) ?? namespace.name;
			const entry = item("namespace", name, quote === null ? quoted(name) : name.replaceAll(quote.char, quote.char + quote.char) + (quote.closed ? "" : quote.char), samePath(namespace.path, lookup.current) ? CURRENT_DETAIL : null);
			return namespace.system ? {
				...entry,
				boost: SYSTEM_NAMESPACE_BOOST
			} : entry;
		});
	}
	async function complete(request, catalog) {
		if (request.scope === void 0) {
			const slot = namespaceSlotAt(request.text, request.offset, options.dialect);
			if (slot !== null) {
				const lookup = new Lookup(catalog);
				await lookup.follow(request.text, request.offset);
				const items = await namespaceItems(slot, lookup);
				return {
					from: slot.from,
					to: slot.to,
					items,
					validFor: slot.quote === null ? UNQUOTED_WORD : null
				};
			}
		}
		const { text, offset, shift } = wrap(request);
		const scope = scopeAt(text, offset, options.dialect);
		const lookup = new Lookup(catalog);
		if (request.scope === void 0) await lookup.follow(text, offset);
		const items = await itemsFor(scope, lookup);
		const typedQuote = QUOTES.has(text.charAt(scope.prefixFrom)) && scope.prefixFrom < offset;
		return {
			from: scope.prefixFrom - shift,
			to: offset - shift,
			items: typedQuote ? quotedLabels(items) : items,
			validFor: typedQuote ? null : UNQUOTED_WORD
		};
	}
	function sourceDeclaring(query, word) {
		for (const level of levels(query)) for (const source of level.sources) if (source.kind === "relation" && (source.name.from === word.from || source.alias?.from === word.from)) return source;
	}
	async function relationDeclaration(lookup, qualifier, name) {
		const found = await lookup.relation(qualifier, name);
		return found === null ? null : {
			kind: "relation",
			path: found.path,
			relation: found.relation.name
		};
	}
	async function columnDeclaration(lookup, source, query, column) {
		if (source.kind !== "relation") return null;
		if (source.qualifier.length === 0 && cteNamed(query, source.name) !== void 0) return null;
		const found = await lookup.relation(source.qualifier, source.name);
		const meta = found?.relation.columns.find((candidate) => denotes(column, candidate.name));
		return found === null || meta === void 0 ? null : {
			kind: "column",
			path: found.path,
			relation: found.relation.name,
			column: meta.name
		};
	}
	async function resolve(request, catalog) {
		const scope = scopeAt(request.text, request.offset, options.dialect, "resolve");
		const { word, qualifier, query } = scope;
		if (word === null || scope.clause === "none") return null;
		const lookup = new Lookup(catalog);
		await lookup.follow(request.text, request.offset);
		const cte = visibleCtes(query).find((candidate) => candidate.name.from === word.from);
		if (cte !== void 0) return {
			kind: "cte",
			from: cte.name.from,
			to: cte.name.to
		};
		const declaring = sourceDeclaring(query, word);
		if (declaring !== void 0) {
			if (declaring.alias?.from === word.from) return {
				kind: "alias",
				from: declaring.from,
				to: declaring.to
			};
			if (declaring.qualifier.length === 0) {
				const named = cteNamed(query, word);
				if (named !== void 0) return {
					kind: "cte",
					from: named.name.from,
					to: named.name.to
				};
			}
			return relationDeclaration(lookup, declaring.qualifier, declaring.name);
		}
		if (qualifier.length === 0) {
			const source = sourceNamed(query, word);
			if (source !== void 0 && (scope.dotAfter || source.alias !== null)) {
				if (source.alias !== null) return {
					kind: "alias",
					from: source.from,
					to: source.to
				};
				if (source.kind === "relation") return relationDeclaration(lookup, source.qualifier, source.name);
			}
			const named = cteNamed(query, word);
			if (named !== void 0) return {
				kind: "cte",
				from: named.name.from,
				to: named.name.to
			};
			if (!scope.dotAfter && scope.clause === "columns") for (const candidate of query.sources) {
				const declaration = await columnDeclaration(lookup, candidate, query, word);
				if (declaration !== null) return declaration;
			}
			return relationDeclaration(lookup, [], word);
		}
		if (qualifier.length === 1 && qualifier[0] !== void 0) {
			const source = sourceNamed(query, qualifier[0]);
			if (source !== void 0) return columnDeclaration(lookup, source, query, word);
		}
		const asRelation = await relationDeclaration(lookup, qualifier, word);
		if (asRelation !== null) return asRelation;
		const owner = qualifier.at(-1);
		if (owner === void 0) return null;
		const found = await lookup.relation(qualifier.slice(0, -1), owner);
		const meta = found?.relation.columns.find((candidate) => denotes(word, candidate.name));
		return found === null || meta === void 0 ? null : {
			kind: "column",
			path: found.path,
			relation: found.relation.name,
			column: meta.name
		};
	}
	/** Whether a qualifier written before a column or `*` names the one table the SELECT reads. */
	function namesTable(qualifier, select) {
		const last = qualifier.at(-1);
		if (last === void 0) return true;
		if (select.alias !== null) return qualifier.length === 1 && sameIdentifier(last, select.alias);
		const tail = [...select.qualifier, select.name].slice(-qualifier.length);
		return tail.length === qualifier.length && qualifier.every((part, at) => {
			const other = tail[at];
			return other !== void 0 && sameIdentifier(part, other);
		});
	}
	async function selectSource(sql, catalog) {
		const select = parseSimpleSelect(sql, options.dialect);
		if ("readOnly" in select) return {
			kind: "readOnly",
			reason: select.readOnly
		};
		const found = await new Lookup(catalog).relation(select.qualifier, select.name);
		if (found === null) return {
			kind: "readOnly",
			reason: `the catalog does not know ${select.name.name}`
		};
		const tableColumns = found.relation.columns.map((column) => column.name);
		const columns = [];
		for (const item of select.items) {
			if (item.kind === "expression") {
				columns.push(null);
				continue;
			}
			if (!namesTable(item.kind === "star" ? item.qualifier === null ? [] : [item.qualifier] : item.qualifier, select)) return {
				kind: "readOnly",
				reason: SELECT_READ_ONLY_REASONS.notSelect
			};
			if (item.kind === "star") {
				columns.push(...tableColumns);
				continue;
			}
			columns.push(tableColumns.find((name) => denotes(item.name, name)) ?? null);
		}
		return {
			kind: "table",
			path: found.path,
			relation: found.relation.name,
			columns
		};
	}
	function signatureAt(request, catalog) {
		const { text, offset, shift } = wrap(request);
		const server = serverOf(catalog);
		const call = callAt(text, offset, options.dialect, reserved, (name) => specNamed(name, server) !== void 0);
		const spec = call === null ? void 0 : specNamed(call.name, server);
		if (call === null || spec === void 0) return Promise.resolve(null);
		return Promise.resolve({
			name: spec.name.toLowerCase(),
			summary: spec.summary,
			signatures: spec.signatures,
			argument: call.argument,
			from: call.from - shift,
			to: call.to - shift
		});
	}
	return {
		complete,
		resolve,
		selectSource,
		signatureAt
	};
}
// ../plugin-api/src/sql/words.ts
var OPEN_PAREN = "(";
var CLOSE_PAREN = ")";
var WITH$1 = "WITH";
var MAIN_VERBS = /* @__PURE__ */ new Set([
	"SELECT",
	"INSERT",
	"UPDATE",
	"DELETE",
	"MERGE"
]);
/** The statement's words, upper-cased, each with its parenthesis depth. */
function words(sql, tokens) {
	const found = [];
	let depth = 0;
	for (const token of tokens) if (token.kind === "symbol") {
		const char = sql.charAt(token.from);
		if (char === OPEN_PAREN) depth += 1;
		else if (char === CLOSE_PAREN) depth = Math.max(0, depth - 1);
	} else if (token.kind === "word") found.push({
		word: wordOf(sql, token),
		depth
	});
	return found;
}
/** The verb that decides what a `WITH …` statement does: the first one outside the CTEs' parentheses. */
function mainVerb(list) {
	if (list[0]?.word !== WITH$1) return 0;
	const index = list.findIndex((entry, at) => at > 0 && entry.depth === 0 && MAIN_VERBS.has(entry.word));
	return index < 0 ? 0 : index;
}
/** MySQL reads `DESCRIBE` and `DESC` before a statement as `EXPLAIN`, `ANALYZE` included. */
var EXPLAIN_VERBS$1 = /* @__PURE__ */ new Set([
	"EXPLAIN",
	"DESCRIBE",
	"DESC"
]);
var ANALYZE_WORDS = /* @__PURE__ */ new Set(["ANALYZE", "ANALYSE"]);
/** PostgreSQL's boolean option values that turn `ANALYZE` off inside `EXPLAIN ( … )`. */
var FALSE_WORDS = /* @__PURE__ */ new Set([
	"FALSE",
	"OFF",
	"0"
]);
/** Words between `EXPLAIN` and the statement that take no value. */
var FLAG_WORDS = /* @__PURE__ */ new Set([
	"VERBOSE",
	"QUERY",
	"PLAN",
	"EXTENDED",
	"PARTITIONS"
]);
var FORMAT = "FORMAT";
/**
* Reads `EXPLAIN [ANALYZE | ANALYSE] [VERBOSE] [( … )] [FORMAT = x] [QUERY PLAN] <statement>`
* (decision 031); null when the list does not start with `EXPLAIN`, `DESCRIBE` or `DESC`.
*/
function explainPrefix(list) {
	const first = list[0]?.word;
	if (first === void 0 || !EXPLAIN_VERBS$1.has(first)) return null;
	let analyze = false;
	let at = 1;
	for (let entry = list[at]; entry !== void 0; entry = list[at]) if (entry.depth > 0) {
		if (ANALYZE_WORDS.has(entry.word)) {
			const value = list[at + 1];
			analyze = !(value !== void 0 && value.depth > 0 && FALSE_WORDS.has(value.word));
		}
		at += 1;
	} else if (ANALYZE_WORDS.has(entry.word)) {
		analyze = true;
		at += 1;
	} else if (entry.word === FORMAT) at += 2;
	else if (FLAG_WORDS.has(entry.word)) at += 1;
	else break;
	return {
		analyze,
		statementAt: Math.min(at, list.length)
	};
}
// ../plugin-api/src/sql/classify.ts
var KINDS = new Map([
	...[
		"SELECT",
		"SHOW",
		"EXPLAIN",
		"DESCRIBE",
		"DESC",
		"VALUES",
		"TABLE"
	].map((word) => [word, "read"]),
	...[
		"INSERT",
		"UPDATE",
		"DELETE",
		"MERGE",
		"REPLACE",
		"UPSERT",
		"COPY",
		"LOAD"
	].map((word) => [word, "write"]),
	...[
		"CREATE",
		"ALTER",
		"DROP",
		"TRUNCATE",
		"RENAME",
		"COMMENT"
	].map((word) => [word, "ddl"]),
	...[
		"BEGIN",
		"COMMIT",
		"ROLLBACK",
		"SAVEPOINT",
		"RELEASE",
		"END",
		"ABORT"
	].map((word) => [word, "transaction"])
]);
var START$1 = "START";
var TRANSACTION = "TRANSACTION";
var WHERE = "WHERE";
var LIMIT$1 = "LIMIT";
var WITH = "WITH";
/** Prefixes the explained statement's destructive reason, so the confirmation says why it matters. */
var EXPLAIN_ANALYZE_REASON_PREFIX = "EXPLAIN ANALYZE runs it: ";
function hasTopLevel(list, from, word) {
	return list.some((entry, at) => at > from && entry.depth === 0 && entry.word === word);
}
function destructiveReason(list, verbAt) {
	switch (list[verbAt]?.word) {
		case "DELETE":
			if (hasTopLevel(list, verbAt, WHERE)) return null;
			return hasTopLevel(list, verbAt, LIMIT$1) ? "DELETE without WHERE (LIMIT does not choose the rows)" : "DELETE without WHERE";
		case "UPDATE": return hasTopLevel(list, verbAt, WHERE) ? null : "UPDATE without WHERE";
		case "DROP": {
			const object = list[verbAt + 1]?.word;
			return object === void 0 ? "DROP" : `DROP ${object}`;
		}
		case "TRUNCATE": return "TRUNCATE";
		default: return null;
	}
}
/**
* A token-level classifier plugins may build `SqlLanguage.classify` on (decision 023). The first
* keyword picks the kind; `UPDATE` or `DELETE` without a top-level `WHERE`, `DROP` and `TRUNCATE`
* are destructive (decision 011). `EXPLAIN` is a read unless it analyses, which runs the statement,
* so `EXPLAIN ANALYZE` takes the statement's kind and destructive reason (decision 031). It never
* parses, so it never rejects a statement.
*/
function classifyTokens(sql, options = {}) {
	const statementClass = classifyWords(words(sql, significantTokens(sql, options)));
	return namespaceTarget(sql, options) === null ? statementClass : {
		...statementClass,
		setsNamespace: true
	};
}
function classifyWords(list) {
	const first = list[0]?.word;
	if (first === void 0) return {
		kind: "other",
		destructive: null
	};
	if (first === START$1) return {
		kind: list[1]?.word === TRANSACTION ? "transaction" : "other",
		destructive: null
	};
	const explain = explainPrefix(list);
	if (explain !== null) {
		if (!explain.analyze) return {
			kind: "read",
			destructive: null
		};
		const inner = classifyWords(list.slice(explain.statementAt));
		return {
			kind: inner.kind,
			destructive: inner.destructive === null ? null : `${EXPLAIN_ANALYZE_REASON_PREFIX}${inner.destructive}`
		};
	}
	const verbAt = mainVerb(list);
	const verb = list[verbAt]?.word ?? first;
	return {
		kind: first === WITH && verbAt === 0 ? "read" : KINDS.get(verb) ?? "other",
		destructive: destructiveReason(list, verbAt)
	};
}
var ENDS = /* @__PURE__ */ new Set([
	"COMMIT",
	"END",
	"ABORT"
]);
var ROLLBACK = "ROLLBACK";
var TO = "TO";
var PREPARE = "PREPARE";
/**
* Whether a statement opens or ends a transaction, for plugins that track `Transactions.open` in
* auto mode: `BEGIN` and `START TRANSACTION` open one; `COMMIT`, `ROLLBACK` (not `ROLLBACK TO`),
* `END`, `ABORT` and `PREPARE TRANSACTION` end it. Null for anything else.
*/
function transactionEffect(sql, options = {}) {
	const list = words(sql, significantTokens(sql, options)).map((entry) => entry.word);
	const [first, second] = list;
	if (first === "BEGIN" || first === START$1 && second === TRANSACTION) return "begin";
	if (first !== void 0 && ENDS.has(first)) return "end";
	if (first === PREPARE && second === TRANSACTION) return "end";
	if (first === ROLLBACK) return list.includes(TO) ? null : "end";
	return null;
}
// ../../node_modules/.bun/sql-formatter@15.9.0/node_modules/sql-formatter/dist/esm/expandPhrases.js
/**
* Performs expandSinglePhrase() on array
*/
var expandPhrases = (phrases) => phrases.flatMap(expandSinglePhrase);
/**
* Expands a syntax description like
*
*     "CREATE [OR REPLACE] [TEMP|TEMPORARY] TABLE"
*
* into an array of all possible combinations like:
*
*     [ "CREATE TABLE",
*       "CREATE TEMP TABLE",
*       "CREATE TEMPORARY TABLE",
*       "CREATE OR REPLACE TABLE",
*       "CREATE OR REPLACE TEMP TABLE",
*       "CREATE OR REPLACE TEMPORARY TABLE" ]
*
* The [] and {} parenthesis can also be nested like
*
*     "FOR [OF {UNIQUE | MANDATORY} TABLES]"
*
* resulting in:
*
*     [ "FOR",
*       "FOR OF UNIQUE TABLES",
*       "FOR OF MANDATORY TABLES" ]
*/
var expandSinglePhrase = (phrase) => buildCombinations(parsePhrase(phrase)).map(stripExtraWhitespace);
var stripExtraWhitespace = (text) => text.replace(/ +/g, " ").trim();
var parsePhrase = (text) => ({
	type: "mandatory_block",
	items: parseAlteration(text, 0)[0]
});
var parseAlteration = (text, index, expectClosing) => {
	const alterations = [];
	while (text[index]) {
		const [term, newIndex] = parseConcatenation(text, index);
		alterations.push(term);
		index = newIndex;
		if (text[index] === "|") index++;
		else if (text[index] === "}" || text[index] === "]") {
			if (expectClosing !== text[index]) throw new Error(`Unbalanced parenthesis in: ${text}`);
			index++;
			return [alterations, index];
		} else if (index === text.length) {
			if (expectClosing) throw new Error(`Unbalanced parenthesis in: ${text}`);
			return [alterations, index];
		} else throw new Error(`Unexpected "${text[index]}"`);
	}
	return [alterations, index];
};
var parseConcatenation = (text, index) => {
	const items = [];
	while (true) {
		const [term, newIndex] = parseTerm(text, index);
		if (term) {
			items.push(term);
			index = newIndex;
		} else break;
	}
	return items.length === 1 ? [items[0], index] : [{
		type: "concatenation",
		items
	}, index];
};
var parseTerm = (text, index) => {
	if (text[index] === "{") return parseMandatoryBlock(text, index + 1);
	else if (text[index] === "[") return parseOptionalBlock(text, index + 1);
	else {
		let word = "";
		while (text[index] && /[A-Za-z0-9_ ]/.test(text[index])) {
			word += text[index];
			index++;
		}
		return [word, index];
	}
};
var parseMandatoryBlock = (text, index) => {
	const [items, newIndex] = parseAlteration(text, index, "}");
	return [{
		type: "mandatory_block",
		items
	}, newIndex];
};
var parseOptionalBlock = (text, index) => {
	const [items, newIndex] = parseAlteration(text, index, "]");
	return [{
		type: "optional_block",
		items
	}, newIndex];
};
var buildCombinations = (node) => {
	if (typeof node === "string") return [node];
	else if (node.type === "concatenation") return node.items.map(buildCombinations).reduce(stringCombinations, [""]);
	else if (node.type === "mandatory_block") return node.items.flatMap(buildCombinations);
	else if (node.type === "optional_block") return ["", ...node.items.flatMap(buildCombinations)];
	else throw new Error(`Unknown node type: ${node}`);
};
var stringCombinations = (xs, ys) => {
	const results = [];
	for (const x of xs) for (const y of ys) results.push(x + y);
	return results;
};
// ../../node_modules/.bun/sql-formatter@15.9.0/node_modules/sql-formatter/dist/esm/lexer/token.js
/** Token type enum for all possible Token categories */
var TokenType;
(function(TokenType) {
	TokenType["QUOTED_IDENTIFIER"] = "QUOTED_IDENTIFIER";
	TokenType["IDENTIFIER"] = "IDENTIFIER";
	TokenType["STRING"] = "STRING";
	TokenType["VARIABLE"] = "VARIABLE";
	TokenType["RESERVED_DATA_TYPE"] = "RESERVED_DATA_TYPE";
	TokenType["RESERVED_PARAMETERIZED_DATA_TYPE"] = "RESERVED_PARAMETERIZED_DATA_TYPE";
	TokenType["RESERVED_KEYWORD"] = "RESERVED_KEYWORD";
	TokenType["RESERVED_FUNCTION_NAME"] = "RESERVED_FUNCTION_NAME";
	TokenType["RESERVED_KEYWORD_PHRASE"] = "RESERVED_KEYWORD_PHRASE";
	TokenType["RESERVED_DATA_TYPE_PHRASE"] = "RESERVED_DATA_TYPE_PHRASE";
	TokenType["RESERVED_SET_OPERATION"] = "RESERVED_SET_OPERATION";
	TokenType["RESERVED_CLAUSE"] = "RESERVED_CLAUSE";
	TokenType["RESERVED_SELECT"] = "RESERVED_SELECT";
	TokenType["RESERVED_JOIN"] = "RESERVED_JOIN";
	TokenType["ARRAY_IDENTIFIER"] = "ARRAY_IDENTIFIER";
	TokenType["ARRAY_KEYWORD"] = "ARRAY_KEYWORD";
	TokenType["CASE"] = "CASE";
	TokenType["END"] = "END";
	TokenType["WHEN"] = "WHEN";
	TokenType["ELSE"] = "ELSE";
	TokenType["THEN"] = "THEN";
	TokenType["LIMIT"] = "LIMIT";
	TokenType["BETWEEN"] = "BETWEEN";
	TokenType["AND"] = "AND";
	TokenType["OR"] = "OR";
	TokenType["XOR"] = "XOR";
	TokenType["OPERATOR"] = "OPERATOR";
	TokenType["COMMA"] = "COMMA";
	TokenType["ASTERISK"] = "ASTERISK";
	TokenType["PROPERTY_ACCESS_OPERATOR"] = "PROPERTY_ACCESS_OPERATOR";
	TokenType["OPEN_PAREN"] = "OPEN_PAREN";
	TokenType["CLOSE_PAREN"] = "CLOSE_PAREN";
	TokenType["LINE_COMMENT"] = "LINE_COMMENT";
	TokenType["BLOCK_COMMENT"] = "BLOCK_COMMENT";
	TokenType["DISABLE_COMMENT"] = "DISABLE_COMMENT";
	TokenType["NUMBER"] = "NUMBER";
	TokenType["NAMED_PARAMETER"] = "NAMED_PARAMETER";
	TokenType["QUOTED_PARAMETER"] = "QUOTED_PARAMETER";
	TokenType["NUMBERED_PARAMETER"] = "NUMBERED_PARAMETER";
	TokenType["POSITIONAL_PARAMETER"] = "POSITIONAL_PARAMETER";
	TokenType["CUSTOM_PARAMETER"] = "CUSTOM_PARAMETER";
	TokenType["DELIMITER"] = "DELIMITER";
	TokenType["EOF"] = "EOF";
})(TokenType = TokenType || (TokenType = {}));
/** Creates EOF token positioned at given location */
var createEofToken = (index) => ({
	type: TokenType.EOF,
	raw: "«EOF»",
	text: "«EOF»",
	start: index
});
/**
* For use as a "missing token"
* e.g. in lookAhead and lookBehind to avoid dealing with null values
*/
var EOF_TOKEN = createEofToken(Infinity);
/** Checks if two tokens are equivalent */
var testToken = (compareToken) => (token) => token.type === compareToken.type && token.text === compareToken.text;
/** Util object that allows for easy checking of Reserved Keywords */
var isToken = {
	ARRAY: testToken({
		text: "ARRAY",
		type: TokenType.RESERVED_DATA_TYPE
	}),
	BY: testToken({
		text: "BY",
		type: TokenType.RESERVED_KEYWORD
	}),
	SET: testToken({
		text: "SET",
		type: TokenType.RESERVED_CLAUSE
	}),
	STRUCT: testToken({
		text: "STRUCT",
		type: TokenType.RESERVED_DATA_TYPE
	}),
	WINDOW: testToken({
		text: "WINDOW",
		type: TokenType.RESERVED_CLAUSE
	}),
	VALUES: testToken({
		text: "VALUES",
		type: TokenType.RESERVED_CLAUSE
	})
};
/** Checks if token is any Reserved Keyword or Clause */
var isReserved = (type) => type === TokenType.RESERVED_DATA_TYPE || type === TokenType.RESERVED_KEYWORD || type === TokenType.RESERVED_FUNCTION_NAME || type === TokenType.RESERVED_KEYWORD_PHRASE || type === TokenType.RESERVED_DATA_TYPE_PHRASE || type === TokenType.RESERVED_CLAUSE || type === TokenType.RESERVED_SELECT || type === TokenType.RESERVED_SET_OPERATION || type === TokenType.RESERVED_JOIN || type === TokenType.ARRAY_KEYWORD || type === TokenType.CASE || type === TokenType.END || type === TokenType.WHEN || type === TokenType.ELSE || type === TokenType.THEN || type === TokenType.LIMIT || type === TokenType.BETWEEN || type === TokenType.AND || type === TokenType.OR || type === TokenType.XOR;
var isLogicalOperator = (type) => type === TokenType.AND || type === TokenType.OR || type === TokenType.XOR;
// ../../node_modules/.bun/sql-formatter@15.9.0/node_modules/sql-formatter/dist/esm/languages/mariadb/likeMariaDb.js
function postProcess(tokens) {
	return tokens.map((token, i) => {
		const nextToken = tokens[i + 1] || EOF_TOKEN;
		if (isToken.SET(token) && nextToken.text === "(") return Object.assign(Object.assign({}, token), { type: TokenType.RESERVED_FUNCTION_NAME });
		const prevToken = tokens[i - 1] || EOF_TOKEN;
		if (isToken.VALUES(token) && prevToken.text === "=") return Object.assign(Object.assign({}, token), { type: TokenType.RESERVED_FUNCTION_NAME });
		return token;
	});
}
// ../../node_modules/.bun/sql-formatter@15.9.0/node_modules/sql-formatter/dist/esm/languages/mysql/mysql.keywords.js
var keywords$2 = [
	"ACCESSIBLE",
	"ADD",
	"ALL",
	"ALTER",
	"ANALYZE",
	"AND",
	"AS",
	"ASC",
	"ASENSITIVE",
	"BEFORE",
	"BETWEEN",
	"BOTH",
	"BY",
	"CALL",
	"CASCADE",
	"CASE",
	"CHANGE",
	"CHECK",
	"COLLATE",
	"COLUMN",
	"CONDITION",
	"CONSTRAINT",
	"CONTINUE",
	"CONVERT",
	"CREATE",
	"CROSS",
	"CUBE",
	"CUME_DIST",
	"CURRENT_DATE",
	"CURRENT_TIME",
	"CURRENT_TIMESTAMP",
	"CURRENT_USER",
	"CURSOR",
	"DATABASE",
	"DATABASES",
	"DAY_HOUR",
	"DAY_MICROSECOND",
	"DAY_MINUTE",
	"DAY_SECOND",
	"DECLARE",
	"DEFAULT",
	"DELAYED",
	"DELETE",
	"DENSE_RANK",
	"DESC",
	"DESCRIBE",
	"DETERMINISTIC",
	"DISTINCT",
	"DISTINCTROW",
	"DIV",
	"DROP",
	"DUAL",
	"EACH",
	"ELSE",
	"ELSEIF",
	"EMPTY",
	"ENCLOSED",
	"ESCAPED",
	"EXCEPT",
	"EXISTS",
	"EXIT",
	"EXPLAIN",
	"FALSE",
	"FETCH",
	"FIRST_VALUE",
	"FOR",
	"FORCE",
	"FOREIGN",
	"FROM",
	"FULLTEXT",
	"FUNCTION",
	"GENERATED",
	"GET",
	"GRANT",
	"GROUP",
	"GROUPING",
	"GROUPS",
	"HAVING",
	"HIGH_PRIORITY",
	"HOUR_MICROSECOND",
	"HOUR_MINUTE",
	"HOUR_SECOND",
	"IF",
	"IGNORE",
	"IN",
	"INDEX",
	"INFILE",
	"INNER",
	"INOUT",
	"INSENSITIVE",
	"INSERT",
	"IN",
	"INTERSECT",
	"INTERVAL",
	"INTO",
	"IO_AFTER_GTIDS",
	"IO_BEFORE_GTIDS",
	"IS",
	"ITERATE",
	"JOIN",
	"JSON_TABLE",
	"KEY",
	"KEYS",
	"KILL",
	"LAG",
	"LAST_VALUE",
	"LATERAL",
	"LEAD",
	"LEADING",
	"LEAVE",
	"LEFT",
	"LIKE",
	"LIMIT",
	"LINEAR",
	"LINES",
	"LOAD",
	"LOCALTIME",
	"LOCALTIMESTAMP",
	"LOCK",
	"LONG",
	"LOOP",
	"LOW_PRIORITY",
	"MASTER_BIND",
	"MASTER_SSL_VERIFY_SERVER_CERT",
	"MATCH",
	"MAXVALUE",
	"MINUTE_MICROSECOND",
	"MINUTE_SECOND",
	"MOD",
	"MODIFIES",
	"NATURAL",
	"NOT",
	"NO_WRITE_TO_BINLOG",
	"NTH_VALUE",
	"NTILE",
	"NULL",
	"OF",
	"ON",
	"OPTIMIZE",
	"OPTIMIZER_COSTS",
	"OPTION",
	"OPTIONALLY",
	"OR",
	"ORDER",
	"OUT",
	"OUTER",
	"OUTFILE",
	"OVER",
	"PARTITION",
	"PERCENT_RANK",
	"PRIMARY",
	"PROCEDURE",
	"PURGE",
	"RANGE",
	"RANK",
	"READ",
	"READS",
	"READ_WRITE",
	"RECURSIVE",
	"REFERENCES",
	"REGEXP",
	"RELEASE",
	"RENAME",
	"REPEAT",
	"REPLACE",
	"REQUIRE",
	"RESIGNAL",
	"RESTRICT",
	"RETURN",
	"REVOKE",
	"RIGHT",
	"RLIKE",
	"ROW",
	"ROWS",
	"ROW_NUMBER",
	"SCHEMA",
	"SCHEMAS",
	"SECOND_MICROSECOND",
	"SELECT",
	"SENSITIVE",
	"SEPARATOR",
	"SET",
	"SHOW",
	"SIGNAL",
	"SPATIAL",
	"SPECIFIC",
	"SQL",
	"SQLEXCEPTION",
	"SQLSTATE",
	"SQLWARNING",
	"SQL_BIG_RESULT",
	"SQL_CALC_FOUND_ROWS",
	"SQL_SMALL_RESULT",
	"SSL",
	"STARTING",
	"STORED",
	"STRAIGHT_JOIN",
	"SYSTEM",
	"TABLE",
	"TERMINATED",
	"THEN",
	"TO",
	"TRAILING",
	"TRIGGER",
	"TRUE",
	"UNDO",
	"UNION",
	"UNIQUE",
	"UNLOCK",
	"UNSIGNED",
	"UPDATE",
	"USAGE",
	"USE",
	"USING",
	"UTC_DATE",
	"UTC_TIME",
	"UTC_TIMESTAMP",
	"VALUES",
	"VIRTUAL",
	"WHEN",
	"WHERE",
	"WHILE",
	"WINDOW",
	"WITH",
	"WRITE",
	"XOR",
	"YEAR_MONTH",
	"ZEROFILL"
];
var dataTypes$2 = [
	"BIGINT",
	"BINARY",
	"BIT",
	"BLOB",
	"BOOL",
	"BOOLEAN",
	"CHAR",
	"CHARACTER",
	"DATE",
	"DATETIME",
	"DEC",
	"DECIMAL",
	"DOUBLE PRECISION",
	"DOUBLE",
	"ENUM",
	"FIXED",
	"FLOAT",
	"FLOAT4",
	"FLOAT8",
	"INT",
	"INT1",
	"INT2",
	"INT3",
	"INT4",
	"INT8",
	"INTEGER",
	"LONGBLOB",
	"LONGTEXT",
	"MEDIUMBLOB",
	"MEDIUMINT",
	"MEDIUMTEXT",
	"MIDDLEINT",
	"NATIONAL CHAR",
	"NATIONAL VARCHAR",
	"NUMERIC",
	"PRECISION",
	"REAL",
	"SMALLINT",
	"TEXT",
	"TIME",
	"TIMESTAMP",
	"TINYBLOB",
	"TINYINT",
	"TINYTEXT",
	"VARBINARY",
	"VARCHAR",
	"VARCHARACTER",
	"VARYING",
	"YEAR"
];
// ../../node_modules/.bun/sql-formatter@15.9.0/node_modules/sql-formatter/dist/esm/languages/mysql/mysql.functions.js
var functions$2 = [
	"ABS",
	"ACOS",
	"ADDDATE",
	"ADDTIME",
	"AES_DECRYPT",
	"AES_ENCRYPT",
	"ANY_VALUE",
	"ASCII",
	"ASIN",
	"ATAN",
	"ATAN2",
	"AVG",
	"BENCHMARK",
	"BIN",
	"BIN_TO_UUID",
	"BINARY",
	"BIT_AND",
	"BIT_COUNT",
	"BIT_LENGTH",
	"BIT_OR",
	"BIT_XOR",
	"CAN_ACCESS_COLUMN",
	"CAN_ACCESS_DATABASE",
	"CAN_ACCESS_TABLE",
	"CAN_ACCESS_USER",
	"CAN_ACCESS_VIEW",
	"CAST",
	"CEIL",
	"CEILING",
	"CHAR",
	"CHAR_LENGTH",
	"CHARACTER_LENGTH",
	"CHARSET",
	"COALESCE",
	"COERCIBILITY",
	"COLLATION",
	"COMPRESS",
	"CONCAT",
	"CONCAT_WS",
	"CONNECTION_ID",
	"CONV",
	"CONVERT",
	"CONVERT_TZ",
	"COS",
	"COT",
	"COUNT",
	"CRC32",
	"CUME_DIST",
	"CURDATE",
	"CURRENT_DATE",
	"CURRENT_ROLE",
	"CURRENT_TIME",
	"CURRENT_TIMESTAMP",
	"CURRENT_USER",
	"CURTIME",
	"DATABASE",
	"DATE",
	"DATE_ADD",
	"DATE_FORMAT",
	"DATE_SUB",
	"DATEDIFF",
	"DAY",
	"DAYNAME",
	"DAYOFMONTH",
	"DAYOFWEEK",
	"DAYOFYEAR",
	"DEFAULT",
	"DEGREES",
	"DENSE_RANK",
	"DIV",
	"ELT",
	"EXP",
	"EXPORT_SET",
	"EXTRACT",
	"EXTRACTVALUE",
	"FIELD",
	"FIND_IN_SET",
	"FIRST_VALUE",
	"FLOOR",
	"FORMAT",
	"FORMAT_BYTES",
	"FORMAT_PICO_TIME",
	"FOUND_ROWS",
	"FROM_BASE64",
	"FROM_DAYS",
	"FROM_UNIXTIME",
	"GEOMCOLLECTION",
	"GEOMETRYCOLLECTION",
	"GET_DD_COLUMN_PRIVILEGES",
	"GET_DD_CREATE_OPTIONS",
	"GET_DD_INDEX_SUB_PART_LENGTH",
	"GET_FORMAT",
	"GET_LOCK",
	"GREATEST",
	"GROUP_CONCAT",
	"GROUPING",
	"GTID_SUBSET",
	"GTID_SUBTRACT",
	"HEX",
	"HOUR",
	"ICU_VERSION",
	"IF",
	"IFNULL",
	"INET_ATON",
	"INET_NTOA",
	"INET6_ATON",
	"INET6_NTOA",
	"INSERT",
	"INSTR",
	"INTERNAL_AUTO_INCREMENT",
	"INTERNAL_AVG_ROW_LENGTH",
	"INTERNAL_CHECK_TIME",
	"INTERNAL_CHECKSUM",
	"INTERNAL_DATA_FREE",
	"INTERNAL_DATA_LENGTH",
	"INTERNAL_DD_CHAR_LENGTH",
	"INTERNAL_GET_COMMENT_OR_ERROR",
	"INTERNAL_GET_ENABLED_ROLE_JSON",
	"INTERNAL_GET_HOSTNAME",
	"INTERNAL_GET_USERNAME",
	"INTERNAL_GET_VIEW_WARNING_OR_ERROR",
	"INTERNAL_INDEX_COLUMN_CARDINALITY",
	"INTERNAL_INDEX_LENGTH",
	"INTERNAL_IS_ENABLED_ROLE",
	"INTERNAL_IS_MANDATORY_ROLE",
	"INTERNAL_KEYS_DISABLED",
	"INTERNAL_MAX_DATA_LENGTH",
	"INTERNAL_TABLE_ROWS",
	"INTERNAL_UPDATE_TIME",
	"INTERVAL",
	"IS",
	"IS_FREE_LOCK",
	"IS_IPV4",
	"IS_IPV4_COMPAT",
	"IS_IPV4_MAPPED",
	"IS_IPV6",
	"IS NOT",
	"IS NOT NULL",
	"IS NULL",
	"IS_USED_LOCK",
	"IS_UUID",
	"ISNULL",
	"JSON_ARRAY",
	"JSON_ARRAY_APPEND",
	"JSON_ARRAY_INSERT",
	"JSON_ARRAYAGG",
	"JSON_CONTAINS",
	"JSON_CONTAINS_PATH",
	"JSON_DEPTH",
	"JSON_EXTRACT",
	"JSON_INSERT",
	"JSON_KEYS",
	"JSON_LENGTH",
	"JSON_MERGE",
	"JSON_MERGE_PATCH",
	"JSON_MERGE_PRESERVE",
	"JSON_OBJECT",
	"JSON_OBJECTAGG",
	"JSON_OVERLAPS",
	"JSON_PRETTY",
	"JSON_QUOTE",
	"JSON_REMOVE",
	"JSON_REPLACE",
	"JSON_SCHEMA_VALID",
	"JSON_SCHEMA_VALIDATION_REPORT",
	"JSON_SEARCH",
	"JSON_SET",
	"JSON_STORAGE_FREE",
	"JSON_STORAGE_SIZE",
	"JSON_TABLE",
	"JSON_TYPE",
	"JSON_UNQUOTE",
	"JSON_VALID",
	"JSON_VALUE",
	"LAG",
	"LAST_DAY",
	"LAST_INSERT_ID",
	"LAST_VALUE",
	"LCASE",
	"LEAD",
	"LEAST",
	"LEFT",
	"LENGTH",
	"LIKE",
	"LINESTRING",
	"LN",
	"LOAD_FILE",
	"LOCALTIME",
	"LOCALTIMESTAMP",
	"LOCATE",
	"LOG",
	"LOG10",
	"LOG2",
	"LOWER",
	"LPAD",
	"LTRIM",
	"MAKE_SET",
	"MAKEDATE",
	"MAKETIME",
	"MASTER_POS_WAIT",
	"MATCH",
	"MAX",
	"MBRCONTAINS",
	"MBRCOVEREDBY",
	"MBRCOVERS",
	"MBRDISJOINT",
	"MBREQUALS",
	"MBRINTERSECTS",
	"MBROVERLAPS",
	"MBRTOUCHES",
	"MBRWITHIN",
	"MD5",
	"MICROSECOND",
	"MID",
	"MIN",
	"MINUTE",
	"MOD",
	"MONTH",
	"MONTHNAME",
	"MULTILINESTRING",
	"MULTIPOINT",
	"MULTIPOLYGON",
	"NAME_CONST",
	"NOW",
	"NTH_VALUE",
	"NTILE",
	"NULLIF",
	"OCT",
	"OCTET_LENGTH",
	"ORD",
	"PERCENT_RANK",
	"PERIOD_ADD",
	"PERIOD_DIFF",
	"PI",
	"POINT",
	"POLYGON",
	"POSITION",
	"POW",
	"POWER",
	"PS_CURRENT_THREAD_ID",
	"PS_THREAD_ID",
	"QUARTER",
	"QUOTE",
	"RADIANS",
	"RAND",
	"RANDOM_BYTES",
	"RANK",
	"REGEXP",
	"REGEXP_INSTR",
	"REGEXP_LIKE",
	"REGEXP_REPLACE",
	"REGEXP_SUBSTR",
	"RELEASE_ALL_LOCKS",
	"RELEASE_LOCK",
	"REPEAT",
	"REPLACE",
	"REVERSE",
	"RIGHT",
	"RLIKE",
	"ROLES_GRAPHML",
	"ROUND",
	"ROW_COUNT",
	"ROW_NUMBER",
	"RPAD",
	"RTRIM",
	"SCHEMA",
	"SEC_TO_TIME",
	"SECOND",
	"SESSION_USER",
	"SHA1",
	"SHA2",
	"SIGN",
	"SIN",
	"SLEEP",
	"SOUNDEX",
	"SOUNDS LIKE",
	"SOURCE_POS_WAIT",
	"SPACE",
	"SQRT",
	"ST_AREA",
	"ST_ASBINARY",
	"ST_ASGEOJSON",
	"ST_ASTEXT",
	"ST_BUFFER",
	"ST_BUFFER_STRATEGY",
	"ST_CENTROID",
	"ST_COLLECT",
	"ST_CONTAINS",
	"ST_CONVEXHULL",
	"ST_CROSSES",
	"ST_DIFFERENCE",
	"ST_DIMENSION",
	"ST_DISJOINT",
	"ST_DISTANCE",
	"ST_DISTANCE_SPHERE",
	"ST_ENDPOINT",
	"ST_ENVELOPE",
	"ST_EQUALS",
	"ST_EXTERIORRING",
	"ST_FRECHETDISTANCE",
	"ST_GEOHASH",
	"ST_GEOMCOLLFROMTEXT",
	"ST_GEOMCOLLFROMWKB",
	"ST_GEOMETRYN",
	"ST_GEOMETRYTYPE",
	"ST_GEOMFROMGEOJSON",
	"ST_GEOMFROMTEXT",
	"ST_GEOMFROMWKB",
	"ST_HAUSDORFFDISTANCE",
	"ST_INTERIORRINGN",
	"ST_INTERSECTION",
	"ST_INTERSECTS",
	"ST_ISCLOSED",
	"ST_ISEMPTY",
	"ST_ISSIMPLE",
	"ST_ISVALID",
	"ST_LATFROMGEOHASH",
	"ST_LATITUDE",
	"ST_LENGTH",
	"ST_LINEFROMTEXT",
	"ST_LINEFROMWKB",
	"ST_LINEINTERPOLATEPOINT",
	"ST_LINEINTERPOLATEPOINTS",
	"ST_LONGFROMGEOHASH",
	"ST_LONGITUDE",
	"ST_MAKEENVELOPE",
	"ST_MLINEFROMTEXT",
	"ST_MLINEFROMWKB",
	"ST_MPOINTFROMTEXT",
	"ST_MPOINTFROMWKB",
	"ST_MPOLYFROMTEXT",
	"ST_MPOLYFROMWKB",
	"ST_NUMGEOMETRIES",
	"ST_NUMINTERIORRING",
	"ST_NUMPOINTS",
	"ST_OVERLAPS",
	"ST_POINTATDISTANCE",
	"ST_POINTFROMGEOHASH",
	"ST_POINTFROMTEXT",
	"ST_POINTFROMWKB",
	"ST_POINTN",
	"ST_POLYFROMTEXT",
	"ST_POLYFROMWKB",
	"ST_SIMPLIFY",
	"ST_SRID",
	"ST_STARTPOINT",
	"ST_SWAPXY",
	"ST_SYMDIFFERENCE",
	"ST_TOUCHES",
	"ST_TRANSFORM",
	"ST_UNION",
	"ST_VALIDATE",
	"ST_WITHIN",
	"ST_X",
	"ST_Y",
	"STATEMENT_DIGEST",
	"STATEMENT_DIGEST_TEXT",
	"STD",
	"STDDEV",
	"STDDEV_POP",
	"STDDEV_SAMP",
	"STR_TO_DATE",
	"STRCMP",
	"SUBDATE",
	"SUBSTR",
	"SUBSTRING",
	"SUBSTRING_INDEX",
	"SUBTIME",
	"SUM",
	"SYSDATE",
	"SYSTEM_USER",
	"TAN",
	"TIME",
	"TIME_FORMAT",
	"TIME_TO_SEC",
	"TIMEDIFF",
	"TIMESTAMP",
	"TIMESTAMPADD",
	"TIMESTAMPDIFF",
	"TO_BASE64",
	"TO_DAYS",
	"TO_SECONDS",
	"TRIM",
	"TRUNCATE",
	"UCASE",
	"UNCOMPRESS",
	"UNCOMPRESSED_LENGTH",
	"UNHEX",
	"UNIX_TIMESTAMP",
	"UPDATEXML",
	"UPPER",
	"UTC_DATE",
	"UTC_TIME",
	"UTC_TIMESTAMP",
	"UUID",
	"UUID_SHORT",
	"UUID_TO_BIN",
	"VALIDATE_PASSWORD_STRENGTH",
	"VALUES",
	"VAR_POP",
	"VAR_SAMP",
	"VARIANCE",
	"VERSION",
	"WAIT_FOR_EXECUTED_GTID_SET",
	"WAIT_UNTIL_SQL_THREAD_AFTER_GTIDS",
	"WEEK",
	"WEEKDAY",
	"WEEKOFYEAR",
	"WEIGHT_STRING",
	"YEAR",
	"YEARWEEK"
];
// ../../node_modules/.bun/sql-formatter@15.9.0/node_modules/sql-formatter/dist/esm/languages/mysql/mysql.formatter.js
var reservedSelect$2 = expandPhrases(["SELECT [ALL | DISTINCT | DISTINCTROW]"]);
var reservedClauses$2 = expandPhrases([
	"WITH [RECURSIVE]",
	"FROM",
	"WHERE",
	"GROUP BY",
	"HAVING",
	"WINDOW",
	"PARTITION BY",
	"ORDER BY",
	"LIMIT",
	"OFFSET",
	"INSERT [LOW_PRIORITY | DELAYED | HIGH_PRIORITY] [IGNORE] [INTO]",
	"REPLACE [LOW_PRIORITY | DELAYED] [INTO]",
	"VALUES",
	"ON DUPLICATE KEY UPDATE",
	"SET"
]);
var standardOnelineClauses$2 = expandPhrases(["CREATE [TEMPORARY] TABLE [IF NOT EXISTS]"]);
var tabularOnelineClauses$2 = expandPhrases([
	"CREATE [OR REPLACE] [SQL SECURITY DEFINER | SQL SECURITY INVOKER] VIEW [IF NOT EXISTS]",
	"UPDATE [LOW_PRIORITY] [IGNORE]",
	"DELETE [LOW_PRIORITY] [QUICK] [IGNORE] FROM",
	"DROP [TEMPORARY] TABLE [IF EXISTS]",
	"ALTER TABLE",
	"ADD [COLUMN]",
	"{CHANGE | MODIFY} [COLUMN]",
	"DROP [COLUMN]",
	"RENAME [TO | AS]",
	"RENAME COLUMN",
	"ALTER [COLUMN]",
	"{SET | DROP} DEFAULT",
	"TRUNCATE [TABLE]",
	"ALTER DATABASE",
	"ALTER EVENT",
	"ALTER FUNCTION",
	"ALTER INSTANCE",
	"ALTER LOGFILE GROUP",
	"ALTER PROCEDURE",
	"ALTER RESOURCE GROUP",
	"ALTER SERVER",
	"ALTER TABLESPACE",
	"ALTER USER",
	"ALTER VIEW",
	"ANALYZE TABLE",
	"BINLOG",
	"CACHE INDEX",
	"CALL",
	"CHANGE MASTER TO",
	"CHANGE REPLICATION FILTER",
	"CHANGE REPLICATION SOURCE TO",
	"CHECK TABLE",
	"CHECKSUM TABLE",
	"CLONE",
	"COMMIT",
	"CREATE DATABASE",
	"CREATE EVENT",
	"CREATE FUNCTION",
	"CREATE FUNCTION",
	"CREATE INDEX",
	"CREATE LOGFILE GROUP",
	"CREATE PROCEDURE",
	"CREATE RESOURCE GROUP",
	"CREATE ROLE",
	"CREATE SERVER",
	"CREATE SPATIAL REFERENCE SYSTEM",
	"CREATE TABLESPACE",
	"CREATE TRIGGER",
	"CREATE USER",
	"DEALLOCATE PREPARE",
	"DESCRIBE",
	"DROP DATABASE",
	"DROP EVENT",
	"DROP FUNCTION",
	"DROP FUNCTION",
	"DROP INDEX",
	"DROP LOGFILE GROUP",
	"DROP PROCEDURE",
	"DROP RESOURCE GROUP",
	"DROP ROLE",
	"DROP SERVER",
	"DROP SPATIAL REFERENCE SYSTEM",
	"DROP TABLESPACE",
	"DROP TRIGGER",
	"DROP USER",
	"DROP VIEW",
	"EXECUTE",
	"EXPLAIN",
	"FLUSH",
	"GRANT",
	"HANDLER",
	"HELP",
	"IMPORT TABLE",
	"INSTALL COMPONENT",
	"INSTALL PLUGIN",
	"KILL",
	"LOAD DATA",
	"LOAD INDEX INTO CACHE",
	"LOAD XML",
	"LOCK INSTANCE FOR BACKUP",
	"LOCK TABLES",
	"MASTER_POS_WAIT",
	"OPTIMIZE TABLE",
	"PREPARE",
	"PURGE BINARY LOGS",
	"RELEASE SAVEPOINT",
	"RENAME TABLE",
	"RENAME USER",
	"REPAIR TABLE",
	"RESET",
	"RESET MASTER",
	"RESET PERSIST",
	"RESET REPLICA",
	"RESET SLAVE",
	"RESTART",
	"REVOKE",
	"ROLLBACK",
	"ROLLBACK TO SAVEPOINT",
	"SAVEPOINT",
	"SET CHARACTER SET",
	"SET DEFAULT ROLE",
	"SET NAMES",
	"SET PASSWORD",
	"SET RESOURCE GROUP",
	"SET ROLE",
	"SET TRANSACTION",
	"SHOW",
	"SHOW BINARY LOGS",
	"SHOW BINLOG EVENTS",
	"SHOW CHARACTER SET",
	"SHOW COLLATION",
	"SHOW COLUMNS",
	"SHOW CREATE DATABASE",
	"SHOW CREATE EVENT",
	"SHOW CREATE FUNCTION",
	"SHOW CREATE PROCEDURE",
	"SHOW CREATE TABLE",
	"SHOW CREATE TRIGGER",
	"SHOW CREATE USER",
	"SHOW CREATE VIEW",
	"SHOW DATABASES",
	"SHOW ENGINE",
	"SHOW ENGINES",
	"SHOW ERRORS",
	"SHOW EVENTS",
	"SHOW FUNCTION CODE",
	"SHOW FUNCTION STATUS",
	"SHOW GRANTS",
	"SHOW INDEX",
	"SHOW MASTER STATUS",
	"SHOW OPEN TABLES",
	"SHOW PLUGINS",
	"SHOW PRIVILEGES",
	"SHOW PROCEDURE CODE",
	"SHOW PROCEDURE STATUS",
	"SHOW PROCESSLIST",
	"SHOW PROFILE",
	"SHOW PROFILES",
	"SHOW RELAYLOG EVENTS",
	"SHOW REPLICA STATUS",
	"SHOW REPLICAS",
	"SHOW SLAVE",
	"SHOW SLAVE HOSTS",
	"SHOW STATUS",
	"SHOW TABLE STATUS",
	"SHOW TABLES",
	"SHOW TRIGGERS",
	"SHOW VARIABLES",
	"SHOW WARNINGS",
	"SHUTDOWN",
	"SOURCE_POS_WAIT",
	"START GROUP_REPLICATION",
	"START REPLICA",
	"START SLAVE",
	"START TRANSACTION",
	"STOP GROUP_REPLICATION",
	"STOP REPLICA",
	"STOP SLAVE",
	"TABLE",
	"UNINSTALL COMPONENT",
	"UNINSTALL PLUGIN",
	"UNLOCK INSTANCE",
	"UNLOCK TABLES",
	"USE",
	"XA",
	"ITERATE",
	"LEAVE",
	"LOOP",
	"REPEAT",
	"RETURN",
	"WHILE"
]);
var reservedSetOperations$2 = expandPhrases(["UNION [ALL | DISTINCT]"]);
var reservedJoins$2 = expandPhrases([
	"JOIN",
	"{LEFT | RIGHT} [OUTER] JOIN",
	"{INNER | CROSS} JOIN",
	"NATURAL [INNER] JOIN",
	"NATURAL {LEFT | RIGHT} [OUTER] JOIN",
	"STRAIGHT_JOIN"
]);
var reservedKeywordPhrases$2 = expandPhrases([
	"ON {UPDATE | DELETE} [SET NULL]",
	"CHARACTER SET",
	"{ROWS | RANGE} BETWEEN",
	"IDENTIFIED BY"
]);
var reservedDataTypePhrases$2 = expandPhrases([]);
var mysql = {
	name: "mysql",
	tokenizerOptions: {
		reservedSelect: reservedSelect$2,
		reservedClauses: [
			...reservedClauses$2,
			...standardOnelineClauses$2,
			...tabularOnelineClauses$2
		],
		reservedSetOperations: reservedSetOperations$2,
		reservedJoins: reservedJoins$2,
		reservedKeywordPhrases: reservedKeywordPhrases$2,
		reservedDataTypePhrases: reservedDataTypePhrases$2,
		supportsXor: true,
		reservedKeywords: keywords$2,
		reservedDataTypes: dataTypes$2,
		reservedFunctionNames: functions$2,
		stringTypes: [
			"\"\"-qq-bs",
			{
				quote: "''-qq-bs",
				prefixes: ["N"]
			},
			{
				quote: "''-raw",
				prefixes: ["B", "X"],
				requirePrefix: true
			}
		],
		identTypes: ["``"],
		identChars: {
			first: "$",
			rest: "$",
			allowFirstCharNumber: true
		},
		variableTypes: [
			{ regex: "@@?[A-Za-z0-9_.$]+" },
			{
				quote: "\"\"-qq-bs",
				prefixes: ["@"],
				requirePrefix: true
			},
			{
				quote: "''-qq-bs",
				prefixes: ["@"],
				requirePrefix: true
			},
			{
				quote: "``",
				prefixes: ["@"],
				requirePrefix: true
			}
		],
		paramTypes: { positional: true },
		lineCommentTypes: ["--", "#"],
		operators: [
			"%",
			":=",
			"&",
			"|",
			"^",
			"~",
			"<<",
			">>",
			"<=>",
			"->",
			"->>",
			"&&",
			"||",
			"!",
			"*.*"
		],
		postProcess
	},
	formatOptions: {
		onelineClauses: [...standardOnelineClauses$2, ...tabularOnelineClauses$2],
		tabularOnelineClauses: tabularOnelineClauses$2
	}
};
// ../../node_modules/.bun/sql-formatter@15.9.0/node_modules/sql-formatter/dist/esm/languages/postgresql/postgresql.functions.js
var functions$1 = [
	"ABS",
	"ACOS",
	"ACOSD",
	"ACOSH",
	"ASIN",
	"ASIND",
	"ASINH",
	"ATAN",
	"ATAN2",
	"ATAN2D",
	"ATAND",
	"ATANH",
	"CBRT",
	"CEIL",
	"CEILING",
	"COS",
	"COSD",
	"COSH",
	"COT",
	"COTD",
	"DEGREES",
	"DIV",
	"EXP",
	"FACTORIAL",
	"FLOOR",
	"GCD",
	"LCM",
	"LN",
	"LOG",
	"LOG10",
	"MIN_SCALE",
	"MOD",
	"PI",
	"POWER",
	"RADIANS",
	"RANDOM",
	"ROUND",
	"SCALE",
	"SETSEED",
	"SIGN",
	"SIN",
	"SIND",
	"SINH",
	"SQRT",
	"TAN",
	"TAND",
	"TANH",
	"TRIM_SCALE",
	"TRUNC",
	"WIDTH_BUCKET",
	"ABS",
	"ASCII",
	"BIT_LENGTH",
	"BTRIM",
	"CHARACTER_LENGTH",
	"CHAR_LENGTH",
	"CHR",
	"CONCAT",
	"CONCAT_WS",
	"FORMAT",
	"INITCAP",
	"LEFT",
	"LENGTH",
	"LOWER",
	"LPAD",
	"LTRIM",
	"MD5",
	"NORMALIZE",
	"OCTET_LENGTH",
	"OVERLAY",
	"PARSE_IDENT",
	"PG_CLIENT_ENCODING",
	"POSITION",
	"QUOTE_IDENT",
	"QUOTE_LITERAL",
	"QUOTE_NULLABLE",
	"REGEXP_MATCH",
	"REGEXP_MATCHES",
	"REGEXP_REPLACE",
	"REGEXP_SPLIT_TO_ARRAY",
	"REGEXP_SPLIT_TO_TABLE",
	"REPEAT",
	"REPLACE",
	"REVERSE",
	"RIGHT",
	"RPAD",
	"RTRIM",
	"SPLIT_PART",
	"SPRINTF",
	"STARTS_WITH",
	"STRING_AGG",
	"STRING_TO_ARRAY",
	"STRING_TO_TABLE",
	"STRPOS",
	"SUBSTR",
	"SUBSTRING",
	"TO_ASCII",
	"TO_HEX",
	"TRANSLATE",
	"TRIM",
	"UNISTR",
	"UPPER",
	"BIT_COUNT",
	"BIT_LENGTH",
	"BTRIM",
	"CONVERT",
	"CONVERT_FROM",
	"CONVERT_TO",
	"DECODE",
	"ENCODE",
	"GET_BIT",
	"GET_BYTE",
	"LENGTH",
	"LTRIM",
	"MD5",
	"OCTET_LENGTH",
	"OVERLAY",
	"POSITION",
	"RTRIM",
	"SET_BIT",
	"SET_BYTE",
	"SHA224",
	"SHA256",
	"SHA384",
	"SHA512",
	"STRING_AGG",
	"SUBSTR",
	"SUBSTRING",
	"TRIM",
	"BIT_COUNT",
	"BIT_LENGTH",
	"GET_BIT",
	"LENGTH",
	"OCTET_LENGTH",
	"OVERLAY",
	"POSITION",
	"SET_BIT",
	"SUBSTRING",
	"REGEXP_MATCH",
	"REGEXP_MATCHES",
	"REGEXP_REPLACE",
	"REGEXP_SPLIT_TO_ARRAY",
	"REGEXP_SPLIT_TO_TABLE",
	"TO_CHAR",
	"TO_DATE",
	"TO_NUMBER",
	"TO_TIMESTAMP",
	"CLOCK_TIMESTAMP",
	"CURRENT_DATE",
	"CURRENT_TIME",
	"CURRENT_TIMESTAMP",
	"DATE_BIN",
	"DATE_PART",
	"DATE_TRUNC",
	"EXTRACT",
	"ISFINITE",
	"JUSTIFY_DAYS",
	"JUSTIFY_HOURS",
	"JUSTIFY_INTERVAL",
	"LOCALTIME",
	"LOCALTIMESTAMP",
	"MAKE_DATE",
	"MAKE_INTERVAL",
	"MAKE_TIME",
	"MAKE_TIMESTAMP",
	"MAKE_TIMESTAMPTZ",
	"NOW",
	"PG_SLEEP",
	"PG_SLEEP_FOR",
	"PG_SLEEP_UNTIL",
	"STATEMENT_TIMESTAMP",
	"TIMEOFDAY",
	"TO_TIMESTAMP",
	"TRANSACTION_TIMESTAMP",
	"ENUM_FIRST",
	"ENUM_LAST",
	"ENUM_RANGE",
	"AREA",
	"BOUND_BOX",
	"BOX",
	"CENTER",
	"CIRCLE",
	"DIAGONAL",
	"DIAMETER",
	"HEIGHT",
	"ISCLOSED",
	"ISOPEN",
	"LENGTH",
	"LINE",
	"LSEG",
	"NPOINTS",
	"PATH",
	"PCLOSE",
	"POINT",
	"POLYGON",
	"POPEN",
	"RADIUS",
	"SLOPE",
	"WIDTH",
	"ABBREV",
	"BROADCAST",
	"FAMILY",
	"HOST",
	"HOSTMASK",
	"INET_MERGE",
	"INET_SAME_FAMILY",
	"MACADDR8_SET7BIT",
	"MASKLEN",
	"NETMASK",
	"NETWORK",
	"SET_MASKLEN",
	"TRUNC",
	"ARRAY_TO_TSVECTOR",
	"GET_CURRENT_TS_CONFIG",
	"JSONB_TO_TSVECTOR",
	"JSON_TO_TSVECTOR",
	"LENGTH",
	"NUMNODE",
	"PHRASETO_TSQUERY",
	"PLAINTO_TSQUERY",
	"QUERYTREE",
	"SETWEIGHT",
	"STRIP",
	"TO_TSQUERY",
	"TO_TSVECTOR",
	"TSQUERY_PHRASE",
	"TSVECTOR_TO_ARRAY",
	"TS_DEBUG",
	"TS_DELETE",
	"TS_FILTER",
	"TS_HEADLINE",
	"TS_LEXIZE",
	"TS_PARSE",
	"TS_RANK",
	"TS_RANK_CD",
	"TS_REWRITE",
	"TS_STAT",
	"TS_TOKEN_TYPE",
	"WEBSEARCH_TO_TSQUERY",
	"GEN_RANDOM_UUID",
	"UUIDV4",
	"UUIDV7",
	"UUID_EXTRACT_TIMESTAMP",
	"UUID_EXTRACT_VERSION",
	"CURSOR_TO_XML",
	"CURSOR_TO_XMLSCHEMA",
	"DATABASE_TO_XML",
	"DATABASE_TO_XMLSCHEMA",
	"DATABASE_TO_XML_AND_XMLSCHEMA",
	"NEXTVAL",
	"QUERY_TO_XML",
	"QUERY_TO_XMLSCHEMA",
	"QUERY_TO_XML_AND_XMLSCHEMA",
	"SCHEMA_TO_XML",
	"SCHEMA_TO_XMLSCHEMA",
	"SCHEMA_TO_XML_AND_XMLSCHEMA",
	"STRING",
	"TABLE_TO_XML",
	"TABLE_TO_XMLSCHEMA",
	"TABLE_TO_XML_AND_XMLSCHEMA",
	"XMLAGG",
	"XMLCOMMENT",
	"XMLCONCAT",
	"XMLELEMENT",
	"XMLEXISTS",
	"XMLFOREST",
	"XMLPARSE",
	"XMLPI",
	"XMLROOT",
	"XMLSERIALIZE",
	"XMLTABLE",
	"XML_IS_WELL_FORMED",
	"XML_IS_WELL_FORMED_CONTENT",
	"XML_IS_WELL_FORMED_DOCUMENT",
	"XPATH",
	"XPATH_EXISTS",
	"ARRAY_TO_JSON",
	"JSONB_AGG",
	"JSONB_ARRAY_ELEMENTS",
	"JSONB_ARRAY_ELEMENTS_TEXT",
	"JSONB_ARRAY_LENGTH",
	"JSONB_BUILD_ARRAY",
	"JSONB_BUILD_OBJECT",
	"JSONB_EACH",
	"JSONB_EACH_TEXT",
	"JSONB_EXTRACT_PATH",
	"JSONB_EXTRACT_PATH_TEXT",
	"JSONB_INSERT",
	"JSONB_OBJECT",
	"JSONB_OBJECT_AGG",
	"JSONB_OBJECT_KEYS",
	"JSONB_PATH_EXISTS",
	"JSONB_PATH_EXISTS_TZ",
	"JSONB_PATH_MATCH",
	"JSONB_PATH_MATCH_TZ",
	"JSONB_PATH_QUERY",
	"JSONB_PATH_QUERY_ARRAY",
	"JSONB_PATH_QUERY_ARRAY_TZ",
	"JSONB_PATH_QUERY_FIRST",
	"JSONB_PATH_QUERY_FIRST_TZ",
	"JSONB_PATH_QUERY_TZ",
	"JSONB_POPULATE_RECORD",
	"JSONB_POPULATE_RECORDSET",
	"JSONB_PRETTY",
	"JSONB_SET",
	"JSONB_SET_LAX",
	"JSONB_STRIP_NULLS",
	"JSONB_TO_RECORD",
	"JSONB_TO_RECORDSET",
	"JSONB_TYPEOF",
	"JSON_AGG",
	"JSON_ARRAY_ELEMENTS",
	"JSON_ARRAY_ELEMENTS_TEXT",
	"JSON_ARRAY_LENGTH",
	"JSON_BUILD_ARRAY",
	"JSON_BUILD_OBJECT",
	"JSON_EACH",
	"JSON_EACH_TEXT",
	"JSON_EXTRACT_PATH",
	"JSON_EXTRACT_PATH_TEXT",
	"JSON_OBJECT",
	"JSON_OBJECT_AGG",
	"JSON_OBJECT_KEYS",
	"JSON_POPULATE_RECORD",
	"JSON_POPULATE_RECORDSET",
	"JSON_STRIP_NULLS",
	"JSON_TO_RECORD",
	"JSON_TO_RECORDSET",
	"JSON_TYPEOF",
	"ROW_TO_JSON",
	"TO_JSON",
	"TO_JSONB",
	"TO_TIMESTAMP",
	"CURRVAL",
	"LASTVAL",
	"NEXTVAL",
	"SETVAL",
	"COALESCE",
	"GREATEST",
	"LEAST",
	"NULLIF",
	"ARRAY_AGG",
	"ARRAY_APPEND",
	"ARRAY_CAT",
	"ARRAY_DIMS",
	"ARRAY_FILL",
	"ARRAY_LENGTH",
	"ARRAY_LOWER",
	"ARRAY_NDIMS",
	"ARRAY_POSITION",
	"ARRAY_POSITIONS",
	"ARRAY_PREPEND",
	"ARRAY_REMOVE",
	"ARRAY_REPLACE",
	"ARRAY_TO_STRING",
	"ARRAY_UPPER",
	"CARDINALITY",
	"STRING_TO_ARRAY",
	"TRIM_ARRAY",
	"UNNEST",
	"ISEMPTY",
	"LOWER",
	"LOWER_INC",
	"LOWER_INF",
	"MULTIRANGE",
	"RANGE_MERGE",
	"UPPER",
	"UPPER_INC",
	"UPPER_INF",
	"ARRAY_AGG",
	"AVG",
	"BIT_AND",
	"BIT_OR",
	"BIT_XOR",
	"BOOL_AND",
	"BOOL_OR",
	"COALESCE",
	"CORR",
	"COUNT",
	"COVAR_POP",
	"COVAR_SAMP",
	"CUME_DIST",
	"DENSE_RANK",
	"EVERY",
	"GROUPING",
	"JSONB_AGG",
	"JSONB_OBJECT_AGG",
	"JSON_AGG",
	"JSON_OBJECT_AGG",
	"MAX",
	"MIN",
	"MODE",
	"PERCENTILE_CONT",
	"PERCENTILE_DISC",
	"PERCENT_RANK",
	"RANGE_AGG",
	"RANGE_INTERSECT_AGG",
	"RANK",
	"REGR_AVGX",
	"REGR_AVGY",
	"REGR_COUNT",
	"REGR_INTERCEPT",
	"REGR_R2",
	"REGR_SLOPE",
	"REGR_SXX",
	"REGR_SXY",
	"REGR_SYY",
	"STDDEV",
	"STDDEV_POP",
	"STDDEV_SAMP",
	"STRING_AGG",
	"SUM",
	"TO_JSON",
	"TO_JSONB",
	"VARIANCE",
	"VAR_POP",
	"VAR_SAMP",
	"XMLAGG",
	"CUME_DIST",
	"DENSE_RANK",
	"FIRST_VALUE",
	"LAG",
	"LAST_VALUE",
	"LEAD",
	"NTH_VALUE",
	"NTILE",
	"PERCENT_RANK",
	"RANK",
	"ROW_NUMBER",
	"GENERATE_SERIES",
	"GENERATE_SUBSCRIPTS",
	"ACLDEFAULT",
	"ACLEXPLODE",
	"COL_DESCRIPTION",
	"CURRENT_CATALOG",
	"CURRENT_DATABASE",
	"CURRENT_QUERY",
	"CURRENT_ROLE",
	"CURRENT_SCHEMA",
	"CURRENT_SCHEMAS",
	"CURRENT_USER",
	"FORMAT_TYPE",
	"HAS_ANY_COLUMN_PRIVILEGE",
	"HAS_COLUMN_PRIVILEGE",
	"HAS_DATABASE_PRIVILEGE",
	"HAS_FOREIGN_DATA_WRAPPER_PRIVILEGE",
	"HAS_FUNCTION_PRIVILEGE",
	"HAS_LANGUAGE_PRIVILEGE",
	"HAS_SCHEMA_PRIVILEGE",
	"HAS_SEQUENCE_PRIVILEGE",
	"HAS_SERVER_PRIVILEGE",
	"HAS_TABLESPACE_PRIVILEGE",
	"HAS_TABLE_PRIVILEGE",
	"HAS_TYPE_PRIVILEGE",
	"INET_CLIENT_ADDR",
	"INET_CLIENT_PORT",
	"INET_SERVER_ADDR",
	"INET_SERVER_PORT",
	"MAKEACLITEM",
	"OBJ_DESCRIPTION",
	"PG_BACKEND_PID",
	"PG_BLOCKING_PIDS",
	"PG_COLLATION_IS_VISIBLE",
	"PG_CONF_LOAD_TIME",
	"PG_CONTROL_CHECKPOINT",
	"PG_CONTROL_INIT",
	"PG_CONTROL_SYSTEM",
	"PG_CONVERSION_IS_VISIBLE",
	"PG_CURRENT_LOGFILE",
	"PG_CURRENT_SNAPSHOT",
	"PG_CURRENT_XACT_ID",
	"PG_CURRENT_XACT_ID_IF_ASSIGNED",
	"PG_DESCRIBE_OBJECT",
	"PG_FUNCTION_IS_VISIBLE",
	"PG_GET_CATALOG_FOREIGN_KEYS",
	"PG_GET_CONSTRAINTDEF",
	"PG_GET_EXPR",
	"PG_GET_FUNCTIONDEF",
	"PG_GET_FUNCTION_ARGUMENTS",
	"PG_GET_FUNCTION_IDENTITY_ARGUMENTS",
	"PG_GET_FUNCTION_RESULT",
	"PG_GET_INDEXDEF",
	"PG_GET_KEYWORDS",
	"PG_GET_OBJECT_ADDRESS",
	"PG_GET_OWNED_SEQUENCE",
	"PG_GET_RULEDEF",
	"PG_GET_SERIAL_SEQUENCE",
	"PG_GET_STATISTICSOBJDEF",
	"PG_GET_TRIGGERDEF",
	"PG_GET_USERBYID",
	"PG_GET_VIEWDEF",
	"PG_HAS_ROLE",
	"PG_IDENTIFY_OBJECT",
	"PG_IDENTIFY_OBJECT_AS_ADDRESS",
	"PG_INDEXAM_HAS_PROPERTY",
	"PG_INDEX_COLUMN_HAS_PROPERTY",
	"PG_INDEX_HAS_PROPERTY",
	"PG_IS_OTHER_TEMP_SCHEMA",
	"PG_JIT_AVAILABLE",
	"PG_LAST_COMMITTED_XACT",
	"PG_LISTENING_CHANNELS",
	"PG_MY_TEMP_SCHEMA",
	"PG_NOTIFICATION_QUEUE_USAGE",
	"PG_OPCLASS_IS_VISIBLE",
	"PG_OPERATOR_IS_VISIBLE",
	"PG_OPFAMILY_IS_VISIBLE",
	"PG_OPTIONS_TO_TABLE",
	"PG_POSTMASTER_START_TIME",
	"PG_SAFE_SNAPSHOT_BLOCKING_PIDS",
	"PG_SNAPSHOT_XIP",
	"PG_SNAPSHOT_XMAX",
	"PG_SNAPSHOT_XMIN",
	"PG_STATISTICS_OBJ_IS_VISIBLE",
	"PG_TABLESPACE_DATABASES",
	"PG_TABLESPACE_LOCATION",
	"PG_TABLE_IS_VISIBLE",
	"PG_TRIGGER_DEPTH",
	"PG_TS_CONFIG_IS_VISIBLE",
	"PG_TS_DICT_IS_VISIBLE",
	"PG_TS_PARSER_IS_VISIBLE",
	"PG_TS_TEMPLATE_IS_VISIBLE",
	"PG_TYPEOF",
	"PG_TYPE_IS_VISIBLE",
	"PG_VISIBLE_IN_SNAPSHOT",
	"PG_XACT_COMMIT_TIMESTAMP",
	"PG_XACT_COMMIT_TIMESTAMP_ORIGIN",
	"PG_XACT_STATUS",
	"PQSERVERVERSION",
	"ROW_SECURITY_ACTIVE",
	"SESSION_USER",
	"SHOBJ_DESCRIPTION",
	"TO_REGCLASS",
	"TO_REGCOLLATION",
	"TO_REGNAMESPACE",
	"TO_REGOPER",
	"TO_REGOPERATOR",
	"TO_REGPROC",
	"TO_REGPROCEDURE",
	"TO_REGROLE",
	"TO_REGTYPE",
	"TXID_CURRENT",
	"TXID_CURRENT_IF_ASSIGNED",
	"TXID_CURRENT_SNAPSHOT",
	"TXID_SNAPSHOT_XIP",
	"TXID_SNAPSHOT_XMAX",
	"TXID_SNAPSHOT_XMIN",
	"TXID_STATUS",
	"TXID_VISIBLE_IN_SNAPSHOT",
	"USER",
	"VERSION",
	"BRIN_DESUMMARIZE_RANGE",
	"BRIN_SUMMARIZE_NEW_VALUES",
	"BRIN_SUMMARIZE_RANGE",
	"CONVERT_FROM",
	"CURRENT_SETTING",
	"GIN_CLEAN_PENDING_LIST",
	"PG_ADVISORY_LOCK",
	"PG_ADVISORY_LOCK_SHARED",
	"PG_ADVISORY_UNLOCK",
	"PG_ADVISORY_UNLOCK_ALL",
	"PG_ADVISORY_UNLOCK_SHARED",
	"PG_ADVISORY_XACT_LOCK",
	"PG_ADVISORY_XACT_LOCK_SHARED",
	"PG_BACKUP_START_TIME",
	"PG_CANCEL_BACKEND",
	"PG_COLLATION_ACTUAL_VERSION",
	"PG_COLUMN_COMPRESSION",
	"PG_COLUMN_SIZE",
	"PG_COPY_LOGICAL_REPLICATION_SLOT",
	"PG_COPY_PHYSICAL_REPLICATION_SLOT",
	"PG_CREATE_LOGICAL_REPLICATION_SLOT",
	"PG_CREATE_PHYSICAL_REPLICATION_SLOT",
	"PG_CREATE_RESTORE_POINT",
	"PG_CURRENT_WAL_FLUSH_LSN",
	"PG_CURRENT_WAL_INSERT_LSN",
	"PG_CURRENT_WAL_LSN",
	"PG_DATABASE_SIZE",
	"PG_DROP_REPLICATION_SLOT",
	"PG_EXPORT_SNAPSHOT",
	"PG_FILENODE_RELATION",
	"PG_GET_WAL_REPLAY_PAUSE_STATE",
	"PG_IMPORT_SYSTEM_COLLATIONS",
	"PG_INDEXES_SIZE",
	"PG_IS_IN_BACKUP",
	"PG_IS_IN_RECOVERY",
	"PG_IS_WAL_REPLAY_PAUSED",
	"PG_LAST_WAL_RECEIVE_LSN",
	"PG_LAST_WAL_REPLAY_LSN",
	"PG_LAST_XACT_REPLAY_TIMESTAMP",
	"PG_LOGICAL_EMIT_MESSAGE",
	"PG_LOGICAL_SLOT_GET_BINARY_CHANGES",
	"PG_LOGICAL_SLOT_GET_CHANGES",
	"PG_LOGICAL_SLOT_PEEK_BINARY_CHANGES",
	"PG_LOGICAL_SLOT_PEEK_CHANGES",
	"PG_LOG_BACKEND_MEMORY_CONTEXTS",
	"PG_LS_ARCHIVE_STATUSDIR",
	"PG_LS_DIR",
	"PG_LS_LOGDIR",
	"PG_LS_TMPDIR",
	"PG_LS_WALDIR",
	"PG_PARTITION_ANCESTORS",
	"PG_PARTITION_ROOT",
	"PG_PARTITION_TREE",
	"PG_PROMOTE",
	"PG_READ_BINARY_FILE",
	"PG_READ_FILE",
	"PG_RELATION_FILENODE",
	"PG_RELATION_FILEPATH",
	"PG_RELATION_SIZE",
	"PG_RELOAD_CONF",
	"PG_REPLICATION_ORIGIN_ADVANCE",
	"PG_REPLICATION_ORIGIN_CREATE",
	"PG_REPLICATION_ORIGIN_DROP",
	"PG_REPLICATION_ORIGIN_OID",
	"PG_REPLICATION_ORIGIN_PROGRESS",
	"PG_REPLICATION_ORIGIN_SESSION_IS_SETUP",
	"PG_REPLICATION_ORIGIN_SESSION_PROGRESS",
	"PG_REPLICATION_ORIGIN_SESSION_RESET",
	"PG_REPLICATION_ORIGIN_SESSION_SETUP",
	"PG_REPLICATION_ORIGIN_XACT_RESET",
	"PG_REPLICATION_ORIGIN_XACT_SETUP",
	"PG_REPLICATION_SLOT_ADVANCE",
	"PG_ROTATE_LOGFILE",
	"PG_SIZE_BYTES",
	"PG_SIZE_PRETTY",
	"PG_START_BACKUP",
	"PG_STAT_FILE",
	"PG_STOP_BACKUP",
	"PG_SWITCH_WAL",
	"PG_TABLESPACE_SIZE",
	"PG_TABLE_SIZE",
	"PG_TERMINATE_BACKEND",
	"PG_TOTAL_RELATION_SIZE",
	"PG_TRY_ADVISORY_LOCK",
	"PG_TRY_ADVISORY_LOCK_SHARED",
	"PG_TRY_ADVISORY_XACT_LOCK",
	"PG_TRY_ADVISORY_XACT_LOCK_SHARED",
	"PG_WALFILE_NAME",
	"PG_WALFILE_NAME_OFFSET",
	"PG_WAL_LSN_DIFF",
	"PG_WAL_REPLAY_PAUSE",
	"PG_WAL_REPLAY_RESUME",
	"SET_CONFIG",
	"SUPPRESS_REDUNDANT_UPDATES_TRIGGER",
	"TSVECTOR_UPDATE_TRIGGER",
	"TSVECTOR_UPDATE_TRIGGER_COLUMN",
	"PG_EVENT_TRIGGER_DDL_COMMANDS",
	"PG_EVENT_TRIGGER_DROPPED_OBJECTS",
	"PG_EVENT_TRIGGER_TABLE_REWRITE_OID",
	"PG_EVENT_TRIGGER_TABLE_REWRITE_REASON",
	"PG_GET_OBJECT_ADDRESS",
	"PG_MCV_LIST_ITEMS",
	"CAST"
];
// ../../node_modules/.bun/sql-formatter@15.9.0/node_modules/sql-formatter/dist/esm/languages/postgresql/postgresql.keywords.js
var keywords$1 = [
	"ALL",
	"ANALYSE",
	"ANALYZE",
	"AND",
	"ANY",
	"AS",
	"ASC",
	"ASYMMETRIC",
	"AUTHORIZATION",
	"BETWEEN",
	"BINARY",
	"BOTH",
	"CASE",
	"CAST",
	"CHECK",
	"COLLATE",
	"COLLATION",
	"COLUMN",
	"CONCURRENTLY",
	"CONSTRAINT",
	"CREATE",
	"CROSS",
	"CURRENT_CATALOG",
	"CURRENT_DATE",
	"CURRENT_ROLE",
	"CURRENT_SCHEMA",
	"CURRENT_TIME",
	"CURRENT_TIMESTAMP",
	"CURRENT_USER",
	"DAY",
	"DEFAULT",
	"DEFERRABLE",
	"DESC",
	"DISTINCT",
	"DO",
	"ELSE",
	"END",
	"EXCEPT",
	"EXISTS",
	"FALSE",
	"FETCH",
	"FILTER",
	"FOR",
	"FOREIGN",
	"FREEZE",
	"FROM",
	"FULL",
	"GRANT",
	"GROUP",
	"HAVING",
	"HOUR",
	"ILIKE",
	"IN",
	"INITIALLY",
	"INNER",
	"INOUT",
	"INTERSECT",
	"INTO",
	"IS",
	"ISNULL",
	"JOIN",
	"LATERAL",
	"LEADING",
	"LEFT",
	"LIKE",
	"LIMIT",
	"LOCALTIME",
	"LOCALTIMESTAMP",
	"MINUTE",
	"MONTH",
	"NATURAL",
	"NOT",
	"NOTNULL",
	"NULL",
	"NULLIF",
	"OFFSET",
	"ON",
	"ONLY",
	"OR",
	"ORDER",
	"OUT",
	"OUTER",
	"OVER",
	"OVERLAPS",
	"PLACING",
	"PRIMARY",
	"REFERENCES",
	"RETURNING",
	"RIGHT",
	"ROW",
	"SECOND",
	"SELECT",
	"SESSION_USER",
	"SIMILAR",
	"SOME",
	"SYMMETRIC",
	"TABLE",
	"TABLESAMPLE",
	"THEN",
	"TO",
	"TRAILING",
	"TRUE",
	"UNION",
	"UNIQUE",
	"USER",
	"USING",
	"VALUES",
	"VARIADIC",
	"VERBOSE",
	"WHEN",
	"WHERE",
	"WINDOW",
	"WITH",
	"WITHIN",
	"WITHOUT",
	"YEAR"
];
var dataTypes$1 = [
	"ARRAY",
	"BIGINT",
	"BIT",
	"BIT VARYING",
	"BOOL",
	"BOOLEAN",
	"CHAR",
	"CHARACTER",
	"CHARACTER VARYING",
	"DECIMAL",
	"DEC",
	"DOUBLE",
	"ENUM",
	"FLOAT",
	"INT",
	"INTEGER",
	"INTERVAL",
	"NCHAR",
	"NUMERIC",
	"JSON",
	"JSONB",
	"PRECISION",
	"REAL",
	"SMALLINT",
	"TEXT",
	"TIME",
	"TIMESTAMP",
	"TIMESTAMPTZ",
	"UUID",
	"VARCHAR",
	"XML",
	"ZONE"
];
// ../../node_modules/.bun/sql-formatter@15.9.0/node_modules/sql-formatter/dist/esm/languages/postgresql/postgresql.formatter.js
var reservedSelect$1 = expandPhrases(["SELECT [ALL | DISTINCT]"]);
var reservedClauses$1 = expandPhrases([
	"WITH [RECURSIVE]",
	"FROM",
	"WHERE",
	"GROUP BY [ALL | DISTINCT]",
	"HAVING",
	"WINDOW",
	"PARTITION BY",
	"ORDER BY",
	"LIMIT",
	"OFFSET",
	"FETCH {FIRST | NEXT}",
	"FOR {UPDATE | NO KEY UPDATE | SHARE | KEY SHARE} [OF]",
	"INSERT INTO",
	"VALUES",
	"DEFAULT VALUES",
	"SET",
	"RETURNING"
]);
var standardOnelineClauses$1 = expandPhrases(["CREATE [GLOBAL | LOCAL] [TEMPORARY | TEMP | UNLOGGED] TABLE [IF NOT EXISTS]"]);
var tabularOnelineClauses$1 = expandPhrases([
	"CREATE [OR REPLACE] [TEMP | TEMPORARY] [RECURSIVE] VIEW",
	"CREATE [MATERIALIZED] VIEW [IF NOT EXISTS]",
	"UPDATE [ONLY]",
	"WHERE CURRENT OF",
	"ON CONFLICT",
	"DELETE FROM [ONLY]",
	"DROP TABLE [IF EXISTS]",
	"ALTER TABLE [IF EXISTS] [ONLY]",
	"ALTER TABLE ALL IN TABLESPACE",
	"RENAME [COLUMN]",
	"RENAME TO",
	"ADD [COLUMN] [IF NOT EXISTS]",
	"DROP [COLUMN] [IF EXISTS]",
	"ALTER [COLUMN]",
	"SET DATA TYPE",
	"{SET | DROP} DEFAULT",
	"{SET | DROP} NOT NULL",
	"TRUNCATE [TABLE] [ONLY]",
	"SET SCHEMA",
	"{BEFORE | AFTER | INSTEAD OF} {INSERT | UPDATE [OF] | DELETE | TRUNCATE}",
	"[NOT] DEFERRABLE",
	"INITIALLY {DEFERRED | IMMEDIATE}",
	"[NOT] DEFERRABLE INITIALLY {DEFERRED | IMMEDIATE}",
	"ABORT",
	"ALTER AGGREGATE",
	"ALTER COLLATION",
	"ALTER CONVERSION",
	"ALTER DATABASE",
	"ALTER DEFAULT PRIVILEGES",
	"ALTER DOMAIN",
	"ALTER EVENT TRIGGER",
	"ALTER EXTENSION",
	"ALTER FOREIGN DATA WRAPPER",
	"ALTER FOREIGN TABLE",
	"ALTER FUNCTION",
	"ALTER GROUP",
	"ALTER INDEX",
	"ALTER LANGUAGE",
	"ALTER LARGE OBJECT",
	"ALTER MATERIALIZED VIEW",
	"ALTER OPERATOR",
	"ALTER OPERATOR CLASS",
	"ALTER OPERATOR FAMILY",
	"ALTER POLICY",
	"ALTER PROCEDURE",
	"ALTER PUBLICATION",
	"ALTER ROLE",
	"ALTER ROUTINE",
	"ALTER RULE",
	"ALTER SCHEMA",
	"ALTER SEQUENCE",
	"ALTER SERVER",
	"ALTER STATISTICS",
	"ALTER SUBSCRIPTION",
	"ALTER SYSTEM",
	"ALTER TABLESPACE",
	"ALTER TEXT SEARCH CONFIGURATION",
	"ALTER TEXT SEARCH DICTIONARY",
	"ALTER TEXT SEARCH PARSER",
	"ALTER TEXT SEARCH TEMPLATE",
	"ALTER TRIGGER",
	"ALTER TYPE",
	"ALTER USER",
	"ALTER USER MAPPING",
	"ALTER VIEW",
	"ANALYZE",
	"BEGIN",
	"CALL",
	"CHECKPOINT",
	"CLOSE",
	"CLUSTER",
	"COMMENT ON",
	"COMMIT",
	"COMMIT PREPARED",
	"COPY",
	"CREATE ACCESS METHOD",
	"CREATE [OR REPLACE] AGGREGATE",
	"CREATE CAST",
	"CREATE COLLATION",
	"CREATE [DEFAULT] CONVERSION",
	"CREATE DATABASE",
	"CREATE DOMAIN",
	"CREATE EVENT TRIGGER",
	"CREATE EXTENSION",
	"CREATE FOREIGN DATA WRAPPER",
	"CREATE FOREIGN TABLE",
	"CREATE [OR REPLACE] FUNCTION",
	"CREATE GROUP",
	"CREATE [UNIQUE] INDEX",
	"CREATE [OR REPLACE] [TRUSTED] [PROCEDURAL] LANGUAGE",
	"CREATE OPERATOR",
	"CREATE OPERATOR CLASS",
	"CREATE OPERATOR FAMILY",
	"CREATE POLICY",
	"CREATE [OR REPLACE] PROCEDURE",
	"CREATE PUBLICATION",
	"CREATE ROLE",
	"CREATE [OR REPLACE] RULE",
	"CREATE SCHEMA [AUTHORIZATION]",
	"CREATE [TEMPORARY | TEMP | UNLOGGED] SEQUENCE",
	"CREATE SERVER",
	"CREATE STATISTICS",
	"CREATE SUBSCRIPTION",
	"CREATE TABLESPACE",
	"CREATE TEXT SEARCH CONFIGURATION",
	"CREATE TEXT SEARCH DICTIONARY",
	"CREATE TEXT SEARCH PARSER",
	"CREATE TEXT SEARCH TEMPLATE",
	"CREATE [OR REPLACE] TRANSFORM",
	"CREATE [OR REPLACE] [CONSTRAINT] TRIGGER",
	"CREATE TYPE",
	"CREATE USER",
	"CREATE USER MAPPING",
	"DEALLOCATE",
	"DECLARE",
	"DISCARD",
	"DROP ACCESS METHOD",
	"DROP AGGREGATE",
	"DROP CAST",
	"DROP COLLATION",
	"DROP CONVERSION",
	"DROP DATABASE",
	"DROP DOMAIN",
	"DROP EVENT TRIGGER",
	"DROP EXTENSION",
	"DROP FOREIGN DATA WRAPPER",
	"DROP FOREIGN TABLE",
	"DROP FUNCTION",
	"DROP GROUP",
	"DROP IDENTITY",
	"DROP INDEX",
	"DROP LANGUAGE",
	"DROP MATERIALIZED VIEW [IF EXISTS]",
	"DROP OPERATOR",
	"DROP OPERATOR CLASS",
	"DROP OPERATOR FAMILY",
	"DROP OWNED",
	"DROP POLICY",
	"DROP PROCEDURE",
	"DROP PUBLICATION",
	"DROP ROLE",
	"DROP ROUTINE",
	"DROP RULE",
	"DROP SCHEMA",
	"DROP SEQUENCE",
	"DROP SERVER",
	"DROP STATISTICS",
	"DROP SUBSCRIPTION",
	"DROP TABLESPACE",
	"DROP TEXT SEARCH CONFIGURATION",
	"DROP TEXT SEARCH DICTIONARY",
	"DROP TEXT SEARCH PARSER",
	"DROP TEXT SEARCH TEMPLATE",
	"DROP TRANSFORM",
	"DROP TRIGGER",
	"DROP TYPE",
	"DROP USER",
	"DROP USER MAPPING",
	"DROP VIEW",
	"EXECUTE [FUNCTION | PROCEDURE]",
	"EXPLAIN",
	"FETCH",
	"GRANT",
	"IMPORT FOREIGN SCHEMA",
	"LISTEN",
	"LOAD",
	"LOCK",
	"MOVE",
	"NOTIFY",
	"OVERRIDING SYSTEM VALUE",
	"PREPARE",
	"PREPARE TRANSACTION",
	"REASSIGN OWNED",
	"REFRESH MATERIALIZED VIEW",
	"REINDEX",
	"RELEASE SAVEPOINT",
	"RESET [ALL|ROLE|SESSION AUTHORIZATION]",
	"REVOKE",
	"ROLLBACK",
	"ROLLBACK PREPARED",
	"ROLLBACK TO SAVEPOINT",
	"SAVEPOINT",
	"SECURITY LABEL",
	"SELECT INTO",
	"SET CONSTRAINTS",
	"SET ROLE",
	"SET SESSION AUTHORIZATION",
	"SET TRANSACTION",
	"SHOW",
	"START TRANSACTION",
	"UNLISTEN",
	"VACUUM"
]);
var reservedSetOperations$1 = expandPhrases([
	"UNION [ALL | DISTINCT]",
	"EXCEPT [ALL | DISTINCT]",
	"INTERSECT [ALL | DISTINCT]"
]);
var reservedJoins$1 = expandPhrases([
	"JOIN",
	"{LEFT | RIGHT | FULL} [OUTER] JOIN",
	"{INNER | CROSS} JOIN",
	"NATURAL [INNER] JOIN",
	"NATURAL {LEFT | RIGHT | FULL} [OUTER] JOIN"
]);
var reservedKeywordPhrases$1 = expandPhrases([
	"PRIMARY KEY",
	"GENERATED {ALWAYS | BY DEFAULT} AS IDENTITY",
	"ON {UPDATE | DELETE} [NO ACTION | RESTRICT | CASCADE | SET NULL | SET DEFAULT]",
	"DO {NOTHING | UPDATE}",
	"AS MATERIALIZED",
	"FOR EACH ROW",
	"OR {INSERT | UPDATE [OF] | DELETE | TRUNCATE}",
	"{ROWS | RANGE | GROUPS} BETWEEN",
	"IS [NOT] DISTINCT FROM",
	"NULLS {FIRST | LAST}",
	"WITH ORDINALITY"
]);
var reservedDataTypePhrases$1 = expandPhrases(["[TIMESTAMP | TIME] {WITH | WITHOUT} TIME ZONE"]);
var postgresql = {
	name: "postgresql",
	tokenizerOptions: {
		reservedSelect: reservedSelect$1,
		reservedClauses: [
			...reservedClauses$1,
			...standardOnelineClauses$1,
			...tabularOnelineClauses$1
		],
		reservedSetOperations: reservedSetOperations$1,
		reservedJoins: reservedJoins$1,
		reservedKeywordPhrases: reservedKeywordPhrases$1,
		reservedDataTypePhrases: reservedDataTypePhrases$1,
		reservedKeywords: keywords$1,
		reservedDataTypes: dataTypes$1,
		reservedFunctionNames: functions$1,
		nestedBlockComments: true,
		lineCommentTypes: [
			"--",
			"\\restrict ",
			"\\unrestrict "
		],
		extraParens: ["[]"],
		underscoresInNumbers: true,
		stringTypes: [
			"$$",
			{
				quote: "''-qq",
				prefixes: ["U&"]
			},
			{
				quote: "''-qq-bs",
				prefixes: ["E"],
				requirePrefix: true
			},
			{
				quote: "''-raw",
				prefixes: ["B", "X"],
				requirePrefix: true
			}
		],
		identTypes: [{
			quote: "\"\"-qq",
			prefixes: ["U&"]
		}],
		identChars: { rest: "$" },
		paramTypes: { numbered: ["$"] },
		operators: [
			"%",
			"^",
			"|/",
			"||/",
			"@",
			":=",
			"&",
			"|",
			"#",
			"~",
			"<<",
			">>",
			"~>~",
			"~<~",
			"~>=~",
			"~<=~",
			"@-@",
			"@@",
			"##",
			"<->",
			"&&",
			"&<",
			"&>",
			"<<|",
			"&<|",
			"|>>",
			"|&>",
			"<^",
			">^",
			"?#",
			"?-",
			"?|",
			"?-|",
			"?||",
			"@>",
			"<@",
			"<@>",
			"~=",
			"?",
			"@?",
			"?&",
			"->",
			"->>",
			"#>",
			"#>>",
			"#-",
			"=>",
			">>=",
			"<<=",
			"~~",
			"~~*",
			"!~~",
			"!~~*",
			"~",
			"~*",
			"!~",
			"!~*",
			"-|-",
			"||",
			"@@@",
			"!!",
			"^@",
			"<%",
			"%>",
			"<<%",
			"%>>",
			"<<->",
			"<->>",
			"<<<->",
			"<->>>",
			"~>",
			"#=",
			"::",
			":",
			"<#>",
			"<=>",
			"<+>",
			"<~>",
			"<%>",
			"&&&",
			"|=|"
		],
		operatorKeyword: true
	},
	formatOptions: {
		alwaysDenseOperators: ["::", ":"],
		onelineClauses: [...standardOnelineClauses$1, ...tabularOnelineClauses$1],
		tabularOnelineClauses: tabularOnelineClauses$1
	}
};
// ../../node_modules/.bun/sql-formatter@15.9.0/node_modules/sql-formatter/dist/esm/languages/sqlite/sqlite.functions.js
var functions = [
	"ABS",
	"CHANGES",
	"CHAR",
	"COALESCE",
	"FORMAT",
	"GLOB",
	"HEX",
	"IFNULL",
	"IIF",
	"INSTR",
	"LAST_INSERT_ROWID",
	"LENGTH",
	"LIKE",
	"LIKELIHOOD",
	"LIKELY",
	"LOAD_EXTENSION",
	"LOWER",
	"LTRIM",
	"NULLIF",
	"PRINTF",
	"QUOTE",
	"RANDOM",
	"RANDOMBLOB",
	"REPLACE",
	"ROUND",
	"RTRIM",
	"SIGN",
	"SOUNDEX",
	"SQLITE_COMPILEOPTION_GET",
	"SQLITE_COMPILEOPTION_USED",
	"SQLITE_OFFSET",
	"SQLITE_SOURCE_ID",
	"SQLITE_VERSION",
	"SUBSTR",
	"SUBSTRING",
	"TOTAL_CHANGES",
	"TRIM",
	"TYPEOF",
	"UNICODE",
	"UNLIKELY",
	"UPPER",
	"ZEROBLOB",
	"AVG",
	"COUNT",
	"GROUP_CONCAT",
	"MAX",
	"MIN",
	"SUM",
	"TOTAL",
	"DATE",
	"TIME",
	"DATETIME",
	"JULIANDAY",
	"UNIXEPOCH",
	"STRFTIME",
	"row_number",
	"rank",
	"dense_rank",
	"percent_rank",
	"cume_dist",
	"ntile",
	"lag",
	"lead",
	"first_value",
	"last_value",
	"nth_value",
	"ACOS",
	"ACOSH",
	"ASIN",
	"ASINH",
	"ATAN",
	"ATAN2",
	"ATANH",
	"CEIL",
	"CEILING",
	"COS",
	"COSH",
	"DEGREES",
	"EXP",
	"FLOOR",
	"LN",
	"LOG",
	"LOG",
	"LOG10",
	"LOG2",
	"MOD",
	"PI",
	"POW",
	"POWER",
	"RADIANS",
	"SIN",
	"SINH",
	"SQRT",
	"TAN",
	"TANH",
	"TRUNC",
	"JSON",
	"JSON_ARRAY",
	"JSON_ARRAY_LENGTH",
	"JSON_ARRAY_LENGTH",
	"JSON_EXTRACT",
	"JSON_INSERT",
	"JSON_OBJECT",
	"JSON_PATCH",
	"JSON_REMOVE",
	"JSON_REPLACE",
	"JSON_SET",
	"JSON_TYPE",
	"JSON_TYPE",
	"JSON_VALID",
	"JSON_QUOTE",
	"JSON_GROUP_ARRAY",
	"JSON_GROUP_OBJECT",
	"JSON_EACH",
	"JSON_TREE",
	"CAST"
];
// ../../node_modules/.bun/sql-formatter@15.9.0/node_modules/sql-formatter/dist/esm/languages/sqlite/sqlite.keywords.js
var keywords = [
	"ABORT",
	"ACTION",
	"ADD",
	"AFTER",
	"ALL",
	"ALTER",
	"AND",
	"ARE",
	"ALWAYS",
	"ANALYZE",
	"AS",
	"ASC",
	"ATTACH",
	"AUTOINCREMENT",
	"BEFORE",
	"BEGIN",
	"BETWEEN",
	"BY",
	"CASCADE",
	"CASE",
	"CAST",
	"CHECK",
	"COLLATE",
	"COLUMN",
	"COMMIT",
	"CONFLICT",
	"CONSTRAINT",
	"CREATE",
	"CROSS",
	"CURRENT",
	"CURRENT_DATE",
	"CURRENT_TIME",
	"CURRENT_TIMESTAMP",
	"DATABASE",
	"DEFAULT",
	"DEFERRABLE",
	"DEFERRED",
	"DELETE",
	"DESC",
	"DETACH",
	"DISTINCT",
	"DO",
	"DROP",
	"EACH",
	"ELSE",
	"END",
	"ESCAPE",
	"EXCEPT",
	"EXCLUDE",
	"EXCLUSIVE",
	"EXISTS",
	"EXPLAIN",
	"FAIL",
	"FILTER",
	"FIRST",
	"FOLLOWING",
	"FOR",
	"FOREIGN",
	"FROM",
	"FULL",
	"GENERATED",
	"GLOB",
	"GROUP",
	"HAVING",
	"IF",
	"IGNORE",
	"IMMEDIATE",
	"IN",
	"INDEX",
	"INDEXED",
	"INITIALLY",
	"INNER",
	"INSERT",
	"INSTEAD",
	"INTERSECT",
	"INTO",
	"IS",
	"ISNULL",
	"JOIN",
	"KEY",
	"LAST",
	"LEFT",
	"LIKE",
	"LIMIT",
	"MATCH",
	"MATERIALIZED",
	"NATURAL",
	"NO",
	"NOT",
	"NOTHING",
	"NOTNULL",
	"NULL",
	"NULLS",
	"OF",
	"OFFSET",
	"ON",
	"ONLY",
	"OPEN",
	"OR",
	"ORDER",
	"OTHERS",
	"OUTER",
	"OVER",
	"PARTITION",
	"PLAN",
	"PRAGMA",
	"PRECEDING",
	"PRIMARY",
	"QUERY",
	"RAISE",
	"RANGE",
	"RECURSIVE",
	"REFERENCES",
	"REGEXP",
	"REINDEX",
	"RELEASE",
	"RENAME",
	"REPLACE",
	"RESTRICT",
	"RETURNING",
	"RIGHT",
	"ROLLBACK",
	"ROW",
	"ROWS",
	"SAVEPOINT",
	"SELECT",
	"SET",
	"TABLE",
	"TEMP",
	"TEMPORARY",
	"THEN",
	"TIES",
	"TO",
	"TRANSACTION",
	"TRIGGER",
	"UNBOUNDED",
	"UNION",
	"UNIQUE",
	"UPDATE",
	"USING",
	"VACUUM",
	"VALUES",
	"VIEW",
	"VIRTUAL",
	"WHEN",
	"WHERE",
	"WINDOW",
	"WITH",
	"WITHOUT"
];
var dataTypes = [
	"ANY",
	"ARRAY",
	"BLOB",
	"CHARACTER",
	"DECIMAL",
	"INT",
	"INTEGER",
	"NATIVE CHARACTER",
	"NCHAR",
	"NUMERIC",
	"NVARCHAR",
	"REAL",
	"TEXT",
	"VARCHAR",
	"VARYING CHARACTER"
];
// ../../node_modules/.bun/sql-formatter@15.9.0/node_modules/sql-formatter/dist/esm/languages/sqlite/sqlite.formatter.js
var reservedSelect = expandPhrases(["SELECT [ALL | DISTINCT]"]);
var reservedClauses = expandPhrases([
	"WITH [RECURSIVE]",
	"FROM",
	"WHERE",
	"GROUP BY",
	"HAVING",
	"WINDOW",
	"PARTITION BY",
	"ORDER BY",
	"LIMIT",
	"OFFSET",
	"INSERT [OR ABORT | OR FAIL | OR IGNORE | OR REPLACE | OR ROLLBACK] INTO",
	"REPLACE INTO",
	"VALUES",
	"SET",
	"RETURNING"
]);
var standardOnelineClauses = expandPhrases(["CREATE [TEMPORARY | TEMP] TABLE [IF NOT EXISTS]"]);
var tabularOnelineClauses = expandPhrases([
	"CREATE [TEMPORARY | TEMP] VIEW [IF NOT EXISTS]",
	"UPDATE [OR ABORT | OR FAIL | OR IGNORE | OR REPLACE | OR ROLLBACK]",
	"ON CONFLICT",
	"DELETE FROM",
	"DROP TABLE [IF EXISTS]",
	"ALTER TABLE",
	"ADD [COLUMN]",
	"DROP [COLUMN]",
	"RENAME [COLUMN]",
	"RENAME TO",
	"SET SCHEMA"
]);
var reservedSetOperations = expandPhrases([
	"UNION [ALL]",
	"EXCEPT",
	"INTERSECT"
]);
var reservedJoins = expandPhrases([
	"JOIN",
	"{LEFT | RIGHT | FULL} [OUTER] JOIN",
	"{INNER | CROSS} JOIN",
	"NATURAL [INNER] JOIN",
	"NATURAL {LEFT | RIGHT | FULL} [OUTER] JOIN"
]);
var reservedKeywordPhrases = expandPhrases([
	"ON {UPDATE | DELETE} [SET NULL | SET DEFAULT]",
	"{ROWS | RANGE | GROUPS} BETWEEN",
	"DO UPDATE"
]);
var reservedDataTypePhrases = expandPhrases([]);
var sqlite = {
	name: "sqlite",
	tokenizerOptions: {
		reservedSelect,
		reservedClauses: [
			...reservedClauses,
			...standardOnelineClauses,
			...tabularOnelineClauses
		],
		reservedSetOperations,
		reservedJoins,
		reservedKeywordPhrases,
		reservedDataTypePhrases,
		reservedKeywords: keywords,
		reservedDataTypes: dataTypes,
		reservedFunctionNames: functions,
		stringTypes: ["''-qq", {
			quote: "''-raw",
			prefixes: ["X"],
			requirePrefix: true
		}],
		identTypes: [
			`""-qq`,
			"``",
			"[]"
		],
		paramTypes: {
			positional: true,
			numbered: ["?"],
			named: [":", "@"],
			custom: [{
				regex: String.raw`\$[a-zA-Z_][a-zA-Z0-9_]*(?:::[a-zA-Z_][a-zA-Z0-9_]*)*(?:\([^)]*\))?`,
				key: (v) => v.slice(1)
			}]
		},
		operators: [
			"%",
			"~",
			"&",
			"|",
			"<<",
			">>",
			"==",
			"->",
			"->>",
			"||"
		]
	},
	formatOptions: {
		onelineClauses: [...standardOnelineClauses, ...tabularOnelineClauses],
		tabularOnelineClauses
	}
};
// ../../node_modules/.bun/sql-formatter@15.9.0/node_modules/sql-formatter/dist/esm/utils.js
var last = (arr) => arr[arr.length - 1];
var sortByLengthDesc = (strings) => strings.sort((a, b) => b.length - a.length || a.localeCompare(b));
var equalizeWhitespace = (s) => s.replace(/\s+/gu, " ");
var isMultiline = (text) => /\n/.test(text);
// ../../node_modules/.bun/sql-formatter@15.9.0/node_modules/sql-formatter/dist/esm/lexer/regexUtil.js
var escapeRegExp = (string) => string.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
var WHITESPACE_REGEX = /\s+/uy;
var patternToRegex = (pattern) => new RegExp(`(?:${pattern})`, "uy");
var toCaseInsensitivePattern = (prefix) => prefix.split("").map((char) => / /gu.test(char) ? "\\s+" : `[${char.toUpperCase()}${char.toLowerCase()}]`).join("");
var withDashes = (pattern) => pattern + "(?:-" + pattern + ")*";
var prefixesPattern = ({ prefixes, requirePrefix }) => `(?:${prefixes.map(toCaseInsensitivePattern).join("|")}${requirePrefix ? "" : "|"})`;
// ../../node_modules/.bun/sql-formatter@15.9.0/node_modules/sql-formatter/dist/esm/lexer/regexFactory.js
/**
* Builds a RegExp for valid line comments in a SQL dialect
* @param {string[]} lineCommentTypes - list of character strings that denote line comments
*/
var lineComment = (lineCommentTypes) => new RegExp(`(?:${lineCommentTypes.map(escapeRegExp).join("|")}).*?(?=\r\n|\r|\n|$)`, "uy");
/**
* Builds a RegExp for matching either open- or close-parenthesis patterns
*/
var parenthesis = (kind, extraParens = []) => {
	const index = kind === "open" ? 0 : 1;
	return patternToRegex(["()", ...extraParens].map((pair) => pair[index]).map(escapeRegExp).join("|"));
};
/**
* Builds a RegExp containing all operators for a SQL dialect
*/
var operator = (operators) => patternToRegex(`${sortByLengthDesc(operators).map(escapeRegExp).join("|")}`);
var rejectIdentCharsPattern = ({ rest, dashes }) => rest || dashes ? `(?![${rest || ""}${dashes ? "-" : ""}])` : "";
/**
* Builds a RegExp for all Reserved Keywords in a SQL dialect
*/
var reservedWord = (reservedKeywords, identChars = {}) => {
	if (reservedKeywords.length === 0) return /^\b$/u;
	const avoidIdentChars = rejectIdentCharsPattern(identChars);
	const reservedKeywordsPattern = sortByLengthDesc(reservedKeywords).map(escapeRegExp).join("|").replace(/ /gu, "\\s+");
	return new RegExp(`(?:${reservedKeywordsPattern})${avoidIdentChars}\\b`, "iuy");
};
/**
* Builds a RegExp for parameter placeholder patterns
* @param {string[]} paramTypes - list of strings that denote placeholder types
* @param {string} pattern - string that denotes placeholder pattern
*/
var parameter = (paramTypes, pattern) => {
	if (!paramTypes.length) return;
	return patternToRegex(`(?:${paramTypes.map(escapeRegExp).join("|")})(?:${pattern})`);
};
var buildQStringPatterns = () => {
	const specialDelimiterMap = {
		"<": ">",
		"[": "]",
		"(": ")",
		"{": "}"
	};
	const singlePattern = "{left}(?:(?!{right}').)*?{right}";
	const patternList = Object.entries(specialDelimiterMap).map(([left, right]) => singlePattern.replace(/{left}/g, escapeRegExp(left)).replace(/{right}/g, escapeRegExp(right)));
	const specialDelimiters = escapeRegExp(Object.keys(specialDelimiterMap).join(""));
	return `[Qq]'(?:${String.raw`(?<tag>[^\s${specialDelimiters}])(?:(?!\k<tag>').)*?\k<tag>`}|${patternList.join("|")})'`;
};
var quotePatterns = {
	"``": "(?:`[^`]*`)+",
	"[]": String.raw`(?:\[[^\]]*\])(?:\][^\]]*\])*`,
	"\"\"-qq": String.raw`(?:"[^"]*")+`,
	"\"\"-bs": String.raw`(?:"[^"\\]*(?:\\.[^"\\]*)*")`,
	"\"\"-qq-bs": String.raw`(?:"[^"\\]*(?:\\.[^"\\]*)*")+`,
	"\"\"-raw": String.raw`(?:"[^"]*")`,
	"''-qq": String.raw`(?:'[^']*')+`,
	"''-bs": String.raw`(?:'[^'\\]*(?:\\.[^'\\]*)*')`,
	"''-qq-bs": String.raw`(?:'[^'\\]*(?:\\.[^'\\]*)*')+`,
	"''-raw": String.raw`(?:'[^']*')`,
	"$$": String.raw`(?<tag>\$\w*\$)[\s\S]*?\k<tag>`,
	"'''..'''": String.raw`'''[^\\]*?(?:\\.[^\\]*?)*?'''`,
	"\"\"\"..\"\"\"": String.raw`"""[^\\]*?(?:\\.[^\\]*?)*?"""`,
	"{}": String.raw`(?:\{[^\}]*\})`,
	"q''": buildQStringPatterns()
};
var singleQuotePattern = (quoteTypes) => {
	if (typeof quoteTypes === "string") return quotePatterns[quoteTypes];
	else if ("regex" in quoteTypes) return quoteTypes.regex;
	else return prefixesPattern(quoteTypes) + quotePatterns[quoteTypes.quote];
};
/** Builds a RegExp for matching variables */
var variable = (varTypes) => patternToRegex(varTypes.map((varType) => "regex" in varType ? varType.regex : singleQuotePattern(varType)).join("|"));
/** Builds a quote-delimited pattern for matching all given quote types */
var stringPattern = (quoteTypes) => quoteTypes.map(singleQuotePattern).join("|");
/** Builds a RegExp for matching quote-delimited patterns */
var string = (quoteTypes) => patternToRegex(stringPattern(quoteTypes));
/**
* Builds a RegExp for valid identifiers in a SQL dialect
*/
var identifier = (specialChars = {}) => patternToRegex(identifierPattern(specialChars));
/**
* Builds a RegExp string for valid identifiers in a SQL dialect
*/
var identifierPattern = ({ first, rest, dashes, allowFirstCharNumber } = {}) => {
	const letter = "\\p{Alphabetic}\\p{Mark}_";
	const number = "\\p{Decimal_Number}";
	const firstChars = escapeRegExp(first !== null && first !== void 0 ? first : "");
	const restChars = escapeRegExp(rest !== null && rest !== void 0 ? rest : "");
	const pattern = allowFirstCharNumber ? `[${letter}${number}${firstChars}][${letter}${number}${restChars}]*` : `[${letter}${firstChars}][${letter}${number}${restChars}]*`;
	return dashes ? withDashes(pattern) : pattern;
};
// ../../node_modules/.bun/sql-formatter@15.9.0/node_modules/sql-formatter/dist/esm/lexer/lineColFromIndex.js
/**
* Determines line and column number of character index in source code.
*/
function lineColFromIndex(source, index) {
	const lines = source.slice(0, index).split(/\n/);
	return {
		line: lines.length,
		col: lines[lines.length - 1].length + 1
	};
}
// ../../node_modules/.bun/sql-formatter@15.9.0/node_modules/sql-formatter/dist/esm/lexer/TokenizerEngine.js
var TokenizerEngine = class {
	constructor(rules, dialectName) {
		this.rules = rules;
		this.dialectName = dialectName;
		this.input = "";
		this.index = 0;
	}
	/**
	* Takes a SQL string and breaks it into tokens.
	* Each token is an object with type and value.
	*
	* @param {string} input - The SQL string
	* @returns {Token[]} output token stream
	*/
	tokenize(input) {
		this.input = input;
		this.index = 0;
		const tokens = [];
		let token;
		while (this.index < this.input.length) {
			const precedingWhitespace = this.getWhitespace();
			if (this.index < this.input.length) {
				token = this.getNextToken();
				if (!token) throw this.createParseError();
				tokens.push(Object.assign(Object.assign({}, token), { precedingWhitespace }));
			}
		}
		return tokens;
	}
	createParseError() {
		const text = this.input.slice(this.index, this.index + 10);
		const { line, col } = lineColFromIndex(this.input, this.index);
		return /* @__PURE__ */ new Error(`Parse error: Unexpected "${text}" at line ${line} column ${col}.\n${this.dialectInfo()}`);
	}
	dialectInfo() {
		if (this.dialectName === "sql") return "This likely happens because you're using the default \"sql\" dialect.\nIf possible, please select a more specific dialect (like sqlite, postgresql, etc).";
		else return `SQL dialect used: "${this.dialectName}".`;
	}
	getWhitespace() {
		WHITESPACE_REGEX.lastIndex = this.index;
		const matches = WHITESPACE_REGEX.exec(this.input);
		if (matches) {
			this.index += matches[0].length;
			return matches[0];
		}
	}
	getNextToken() {
		for (const rule of this.rules) {
			const token = this.match(rule);
			if (token) return token;
		}
	}
	match(rule) {
		rule.regex.lastIndex = this.index;
		const matches = rule.regex.exec(this.input);
		if (matches) {
			const matchedText = matches[0];
			const token = {
				type: rule.type,
				raw: matchedText,
				text: rule.text ? rule.text(matchedText) : matchedText,
				start: this.index
			};
			if (rule.key) token.key = rule.key(matchedText);
			this.index += matchedText.length;
			return token;
		}
	}
};
// ../../node_modules/.bun/sql-formatter@15.9.0/node_modules/sql-formatter/dist/esm/lexer/NestedComment.js
var START = /\/\*/uy;
var ANY_CHAR = /[\s\S]/uy;
var END$2 = /\*\//uy;
/**
* An object mimicking a regular expression,
* for matching nested block-comments.
*/
var NestedComment = class {
	constructor() {
		this.lastIndex = 0;
	}
	exec(input) {
		let result = "";
		let match;
		let nestLevel = 0;
		if (match = this.matchSection(START, input)) {
			result += match;
			nestLevel++;
		} else return null;
		while (nestLevel > 0) if (match = this.matchSection(START, input)) {
			result += match;
			nestLevel++;
		} else if (match = this.matchSection(END$2, input)) {
			result += match;
			nestLevel--;
		} else if (match = this.matchSection(ANY_CHAR, input)) result += match;
		else return null;
		return [result];
	}
	matchSection(regex, input) {
		regex.lastIndex = this.lastIndex;
		const matches = regex.exec(input);
		if (matches) this.lastIndex += matches[0].length;
		return matches ? matches[0] : null;
	}
};
// ../../node_modules/.bun/sql-formatter@15.9.0/node_modules/sql-formatter/dist/esm/lexer/Tokenizer.js
var Tokenizer = class {
	constructor(cfg, dialectName) {
		this.cfg = cfg;
		this.dialectName = dialectName;
		this.rulesBeforeParams = this.buildRulesBeforeParams(cfg);
		this.rulesAfterParams = this.buildRulesAfterParams(cfg);
	}
	tokenize(input, paramTypesOverrides) {
		const tokens = new TokenizerEngine([
			...this.rulesBeforeParams,
			...this.buildParamRules(this.cfg, paramTypesOverrides),
			...this.rulesAfterParams
		], this.dialectName).tokenize(input);
		return this.cfg.postProcess ? this.cfg.postProcess(tokens) : tokens;
	}
	buildRulesBeforeParams(cfg) {
		var _a, _b, _c;
		return this.validRules([
			{
				type: TokenType.DISABLE_COMMENT,
				regex: /(\/\* *sql-formatter-disable *\*\/[\s\S]*?(?:\/\* *sql-formatter-enable *\*\/|$))/uy
			},
			{
				type: TokenType.BLOCK_COMMENT,
				regex: cfg.nestedBlockComments ? new NestedComment() : /(\/\*[^]*?\*\/)/uy
			},
			{
				type: TokenType.LINE_COMMENT,
				regex: lineComment((_a = cfg.lineCommentTypes) !== null && _a !== void 0 ? _a : ["--"])
			},
			{
				type: TokenType.QUOTED_IDENTIFIER,
				regex: string(cfg.identTypes)
			},
			{
				type: TokenType.NUMBER,
				regex: cfg.underscoresInNumbers ? /(?:0x[0-9a-fA-F_]+|0b[01_]+|(?:-\s*)?(?:[0-9_]*\.[0-9_]+|[0-9_]+(?:\.[0-9_]*)?)(?:[eE][-+]?[0-9_]+(?:\.[0-9_]+)?)?)(?![\w\p{Alphabetic}])/uy : /(?:0x[0-9a-fA-F]+|0b[01]+|(?:-\s*)?(?:[0-9]*\.[0-9]+|[0-9]+(?:\.[0-9]*)?)(?:[eE][-+]?[0-9]+(?:\.[0-9]+)?)?)(?![\w\p{Alphabetic}])/uy
			},
			{
				type: TokenType.RESERVED_KEYWORD_PHRASE,
				regex: reservedWord((_b = cfg.reservedKeywordPhrases) !== null && _b !== void 0 ? _b : [], cfg.identChars),
				text: toCanonical
			},
			{
				type: TokenType.RESERVED_DATA_TYPE_PHRASE,
				regex: reservedWord((_c = cfg.reservedDataTypePhrases) !== null && _c !== void 0 ? _c : [], cfg.identChars),
				text: toCanonical
			},
			{
				type: TokenType.CASE,
				regex: /CASE\b/iuy,
				text: toCanonical
			},
			{
				type: TokenType.END,
				regex: /END\b/iuy,
				text: toCanonical
			},
			{
				type: TokenType.BETWEEN,
				regex: /BETWEEN\b/iuy,
				text: toCanonical
			},
			{
				type: TokenType.LIMIT,
				regex: cfg.reservedClauses.includes("LIMIT") ? /LIMIT\b/iuy : void 0,
				text: toCanonical
			},
			{
				type: TokenType.RESERVED_CLAUSE,
				regex: reservedWord(cfg.reservedClauses, cfg.identChars),
				text: toCanonical
			},
			{
				type: TokenType.RESERVED_SELECT,
				regex: reservedWord(cfg.reservedSelect, cfg.identChars),
				text: toCanonical
			},
			{
				type: TokenType.RESERVED_SET_OPERATION,
				regex: reservedWord(cfg.reservedSetOperations, cfg.identChars),
				text: toCanonical
			},
			{
				type: TokenType.WHEN,
				regex: /WHEN\b/iuy,
				text: toCanonical
			},
			{
				type: TokenType.ELSE,
				regex: /ELSE\b/iuy,
				text: toCanonical
			},
			{
				type: TokenType.THEN,
				regex: /THEN\b/iuy,
				text: toCanonical
			},
			{
				type: TokenType.RESERVED_JOIN,
				regex: reservedWord(cfg.reservedJoins, cfg.identChars),
				text: toCanonical
			},
			{
				type: TokenType.AND,
				regex: /AND\b/iuy,
				text: toCanonical
			},
			{
				type: TokenType.OR,
				regex: /OR\b/iuy,
				text: toCanonical
			},
			{
				type: TokenType.XOR,
				regex: cfg.supportsXor ? /XOR\b/iuy : void 0,
				text: toCanonical
			},
			...cfg.operatorKeyword ? [{
				type: TokenType.OPERATOR,
				regex: /OPERATOR *\([^)]+\)/iuy
			}] : [],
			{
				type: TokenType.RESERVED_FUNCTION_NAME,
				regex: reservedWord(cfg.reservedFunctionNames, cfg.identChars),
				text: toCanonical
			},
			{
				type: TokenType.RESERVED_DATA_TYPE,
				regex: reservedWord(cfg.reservedDataTypes, cfg.identChars),
				text: toCanonical
			},
			{
				type: TokenType.RESERVED_KEYWORD,
				regex: reservedWord(cfg.reservedKeywords, cfg.identChars),
				text: toCanonical
			}
		]);
	}
	buildRulesAfterParams(cfg) {
		var _a, _b;
		return this.validRules([
			{
				type: TokenType.VARIABLE,
				regex: cfg.variableTypes ? variable(cfg.variableTypes) : void 0
			},
			{
				type: TokenType.STRING,
				regex: string(cfg.stringTypes)
			},
			{
				type: TokenType.IDENTIFIER,
				regex: identifier(cfg.identChars)
			},
			{
				type: TokenType.DELIMITER,
				regex: /[;]/uy
			},
			{
				type: TokenType.COMMA,
				regex: /[,]/y
			},
			{
				type: TokenType.OPEN_PAREN,
				regex: parenthesis("open", cfg.extraParens)
			},
			{
				type: TokenType.CLOSE_PAREN,
				regex: parenthesis("close", cfg.extraParens)
			},
			{
				type: TokenType.OPERATOR,
				regex: operator([
					"+",
					"-",
					"/",
					">",
					"<",
					"=",
					"<>",
					"<=",
					">=",
					"!=",
					...(_a = cfg.operators) !== null && _a !== void 0 ? _a : []
				])
			},
			{
				type: TokenType.ASTERISK,
				regex: /[*]/uy
			},
			{
				type: TokenType.PROPERTY_ACCESS_OPERATOR,
				regex: operator([".", ...(_b = cfg.propertyAccessOperators) !== null && _b !== void 0 ? _b : []])
			}
		]);
	}
	buildParamRules(cfg, paramTypesOverrides) {
		var _a, _b, _c, _d, _e;
		const paramTypes = {
			named: (paramTypesOverrides === null || paramTypesOverrides === void 0 ? void 0 : paramTypesOverrides.named) || ((_a = cfg.paramTypes) === null || _a === void 0 ? void 0 : _a.named) || [],
			quoted: (paramTypesOverrides === null || paramTypesOverrides === void 0 ? void 0 : paramTypesOverrides.quoted) || ((_b = cfg.paramTypes) === null || _b === void 0 ? void 0 : _b.quoted) || [],
			numbered: (paramTypesOverrides === null || paramTypesOverrides === void 0 ? void 0 : paramTypesOverrides.numbered) || ((_c = cfg.paramTypes) === null || _c === void 0 ? void 0 : _c.numbered) || [],
			positional: typeof (paramTypesOverrides === null || paramTypesOverrides === void 0 ? void 0 : paramTypesOverrides.positional) === "boolean" ? paramTypesOverrides.positional : (_d = cfg.paramTypes) === null || _d === void 0 ? void 0 : _d.positional,
			custom: (paramTypesOverrides === null || paramTypesOverrides === void 0 ? void 0 : paramTypesOverrides.custom) || ((_e = cfg.paramTypes) === null || _e === void 0 ? void 0 : _e.custom) || []
		};
		return this.validRules([
			{
				type: TokenType.NAMED_PARAMETER,
				regex: parameter(paramTypes.named, identifierPattern(cfg.paramChars || cfg.identChars)),
				key: (v) => v.slice(1)
			},
			{
				type: TokenType.QUOTED_PARAMETER,
				regex: parameter(paramTypes.quoted, stringPattern(cfg.identTypes)),
				key: (v) => (({ tokenKey, quoteChar }) => tokenKey.replace(new RegExp(escapeRegExp("\\" + quoteChar), "gu"), quoteChar))({
					tokenKey: v.slice(2, -1),
					quoteChar: v.slice(-1)
				})
			},
			{
				type: TokenType.NUMBERED_PARAMETER,
				regex: parameter(paramTypes.numbered, "[0-9]+"),
				key: (v) => v.slice(1)
			},
			{
				type: TokenType.POSITIONAL_PARAMETER,
				regex: paramTypes.positional ? /[?]/y : void 0
			},
			...paramTypes.custom.map((customParam) => {
				var _a;
				return {
					type: TokenType.CUSTOM_PARAMETER,
					regex: patternToRegex(customParam.regex),
					key: (_a = customParam.key) !== null && _a !== void 0 ? _a : ((v) => v)
				};
			})
		]);
	}
	validRules(rules) {
		return rules.filter((rule) => Boolean(rule.regex));
	}
};
/**
* Converts keywords (and keyword sequences) to canonical form:
* - in uppercase
* - single spaces between words
*/
var toCanonical = (v) => equalizeWhitespace(v.toUpperCase());
// ../../node_modules/.bun/sql-formatter@15.9.0/node_modules/sql-formatter/dist/esm/dialect.js
var cache = /* @__PURE__ */ new Map();
/**
* Factory function for building Dialect objects.
* When called repeatedly with same options object returns the cached Dialect,
* to avoid the cost of creating it again.
*/
var createDialect = (options) => {
	let dialect = cache.get(options);
	if (!dialect) {
		dialect = dialectFromOptions(options);
		cache.set(options, dialect);
	}
	return dialect;
};
var dialectFromOptions = (dialectOptions) => ({
	tokenizer: new Tokenizer(dialectOptions.tokenizerOptions, dialectOptions.name),
	formatOptions: processDialectFormatOptions(dialectOptions)
});
var processDialectFormatOptions = ({ tokenizerOptions, formatOptions: options }) => {
	var _a, _b;
	return {
		alwaysDenseOperators: options.alwaysDenseOperators || [],
		onelineClauses: Object.fromEntries(options.onelineClauses.map((name) => [name, true])),
		tabularOnelineClauses: Object.fromEntries(((_a = options.tabularOnelineClauses) !== null && _a !== void 0 ? _a : options.onelineClauses).map((name) => [name, true])),
		identifierDashes: Boolean((_b = tokenizerOptions.identChars) === null || _b === void 0 ? void 0 : _b.dashes)
	};
};
// ../../node_modules/.bun/sql-formatter@15.9.0/node_modules/sql-formatter/dist/esm/formatter/config.js
/**
* Creates a string to use for one step of indentation.
*/
function indentString(cfg) {
	if (cfg.indentStyle === "tabularLeft" || cfg.indentStyle === "tabularRight") return " ".repeat(10);
	if (cfg.useTabs) return "	";
	return " ".repeat(cfg.tabWidth);
}
/**
* True when indentStyle is one of the tabular ones.
*/
function isTabularStyle(cfg) {
	return cfg.indentStyle === "tabularLeft" || cfg.indentStyle === "tabularRight";
}
// ../../node_modules/.bun/sql-formatter@15.9.0/node_modules/sql-formatter/dist/esm/formatter/Params.js
/**
* Handles placeholder replacement with given params.
*/
var Params = class {
	constructor(params) {
		this.params = params;
		this.index = 0;
	}
	/**
	* Returns param value that matches given placeholder with param key.
	*/
	get({ key, text }) {
		if (!this.params) return text;
		if (key) return this.params[key];
		return this.params[this.index++];
	}
	/**
	* Returns index of current positional parameter.
	*/
	getPositionalParameterIndex() {
		return this.index;
	}
	/**
	* Sets index of current positional parameter.
	*/
	setPositionalParameterIndex(i) {
		this.index = i;
	}
};
// ../../node_modules/.bun/nearley@2.20.1/node_modules/nearley/lib/nearley.js
var require_nearley = /* @__PURE__ */ __commonJSMin(((exports, module, this$1) => {
	(function(root, factory) {
		if (typeof module === "object" && module.exports) module.exports = factory();
		else root.nearley = factory();
	})(this$1, function() {
		function Rule(name, symbols, postprocess) {
			this.id = ++Rule.highestId;
			this.name = name;
			this.symbols = symbols;
			this.postprocess = postprocess;
			return this;
		}
		Rule.highestId = 0;
		Rule.prototype.toString = function(withCursorAt) {
			var symbolSequence = typeof withCursorAt === "undefined" ? this.symbols.map(getSymbolShortDisplay).join(" ") : this.symbols.slice(0, withCursorAt).map(getSymbolShortDisplay).join(" ") + " ● " + this.symbols.slice(withCursorAt).map(getSymbolShortDisplay).join(" ");
			return this.name + " → " + symbolSequence;
		};
		function State(rule, dot, reference, wantedBy) {
			this.rule = rule;
			this.dot = dot;
			this.reference = reference;
			this.data = [];
			this.wantedBy = wantedBy;
			this.isComplete = this.dot === rule.symbols.length;
		}
		State.prototype.toString = function() {
			return "{" + this.rule.toString(this.dot) + "}, from: " + (this.reference || 0);
		};
		State.prototype.nextState = function(child) {
			var state = new State(this.rule, this.dot + 1, this.reference, this.wantedBy);
			state.left = this;
			state.right = child;
			if (state.isComplete) {
				state.data = state.build();
				state.right = void 0;
			}
			return state;
		};
		State.prototype.build = function() {
			var children = [];
			var node = this;
			do {
				children.push(node.right.data);
				node = node.left;
			} while (node.left);
			children.reverse();
			return children;
		};
		State.prototype.finish = function() {
			if (this.rule.postprocess) this.data = this.rule.postprocess(this.data, this.reference, Parser.fail);
		};
		function Column(grammar, index) {
			this.grammar = grammar;
			this.index = index;
			this.states = [];
			this.wants = {};
			this.scannable = [];
			this.completed = {};
		}
		Column.prototype.process = function(nextColumn) {
			var states = this.states;
			var wants = this.wants;
			var completed = this.completed;
			for (var w = 0; w < states.length; w++) {
				var state = states[w];
				if (state.isComplete) {
					state.finish();
					if (state.data !== Parser.fail) {
						var wantedBy = state.wantedBy;
						for (var i = wantedBy.length; i--;) {
							var left = wantedBy[i];
							this.complete(left, state);
						}
						if (state.reference === this.index) {
							var exp = state.rule.name;
							(this.completed[exp] = this.completed[exp] || []).push(state);
						}
					}
				} else {
					var exp = state.rule.symbols[state.dot];
					if (typeof exp !== "string") {
						this.scannable.push(state);
						continue;
					}
					if (wants[exp]) {
						wants[exp].push(state);
						if (completed.hasOwnProperty(exp)) {
							var nulls = completed[exp];
							for (var i = 0; i < nulls.length; i++) {
								var right = nulls[i];
								this.complete(state, right);
							}
						}
					} else {
						wants[exp] = [state];
						this.predict(exp);
					}
				}
			}
		};
		Column.prototype.predict = function(exp) {
			var rules = this.grammar.byName[exp] || [];
			for (var i = 0; i < rules.length; i++) {
				var r = rules[i];
				var wantedBy = this.wants[exp];
				var s = new State(r, 0, this.index, wantedBy);
				this.states.push(s);
			}
		};
		Column.prototype.complete = function(left, right) {
			var copy = left.nextState(right);
			this.states.push(copy);
		};
		function Grammar(rules, start) {
			this.rules = rules;
			this.start = start || this.rules[0].name;
			var byName = this.byName = {};
			this.rules.forEach(function(rule) {
				if (!byName.hasOwnProperty(rule.name)) byName[rule.name] = [];
				byName[rule.name].push(rule);
			});
		}
		Grammar.fromCompiled = function(rules, start) {
			var lexer = rules.Lexer;
			if (rules.ParserStart) {
				start = rules.ParserStart;
				rules = rules.ParserRules;
			}
			var rules = rules.map(function(r) {
				return new Rule(r.name, r.symbols, r.postprocess);
			});
			var g = new Grammar(rules, start);
			g.lexer = lexer;
			return g;
		};
		function StreamLexer() {
			this.reset("");
		}
		StreamLexer.prototype.reset = function(data, state) {
			this.buffer = data;
			this.index = 0;
			this.line = state ? state.line : 1;
			this.lastLineBreak = state ? -state.col : 0;
		};
		StreamLexer.prototype.next = function() {
			if (this.index < this.buffer.length) {
				var ch = this.buffer[this.index++];
				if (ch === "\n") {
					this.line += 1;
					this.lastLineBreak = this.index;
				}
				return { value: ch };
			}
		};
		StreamLexer.prototype.save = function() {
			return {
				line: this.line,
				col: this.index - this.lastLineBreak
			};
		};
		StreamLexer.prototype.formatError = function(token, message) {
			var buffer = this.buffer;
			if (typeof buffer === "string") {
				var lines = buffer.split("\n").slice(Math.max(0, this.line - 5), this.line);
				var nextLineBreak = buffer.indexOf("\n", this.index);
				if (nextLineBreak === -1) nextLineBreak = buffer.length;
				var col = this.index - this.lastLineBreak;
				var lastLineDigits = String(this.line).length;
				message += " at line " + this.line + " col " + col + ":\n\n";
				message += lines.map(function(line, i) {
					return pad(this.line - lines.length + i + 1, lastLineDigits) + " " + line;
				}, this).join("\n");
				message += "\n" + pad("", lastLineDigits + col) + "^\n";
				return message;
			} else return message + " at index " + (this.index - 1);
			function pad(n, length) {
				var s = String(n);
				return Array(length - s.length + 1).join(" ") + s;
			}
		};
		function Parser(rules, start, options) {
			if (rules instanceof Grammar) {
				var grammar = rules;
				var options = start;
			} else var grammar = Grammar.fromCompiled(rules, start);
			this.grammar = grammar;
			this.options = {
				keepHistory: false,
				lexer: grammar.lexer || new StreamLexer()
			};
			for (var key in options || {}) this.options[key] = options[key];
			this.lexer = this.options.lexer;
			this.lexerState = void 0;
			var column = new Column(grammar, 0);
			this.table = [column];
			column.wants[grammar.start] = [];
			column.predict(grammar.start);
			column.process();
			this.current = 0;
		}
		Parser.fail = {};
		Parser.prototype.feed = function(chunk) {
			var lexer = this.lexer;
			lexer.reset(chunk, this.lexerState);
			var token;
			while (true) {
				try {
					token = lexer.next();
					if (!token) break;
				} catch (e) {
					var nextColumn = new Column(this.grammar, this.current + 1);
					this.table.push(nextColumn);
					var err = new Error(this.reportLexerError(e));
					err.offset = this.current;
					err.token = e.token;
					throw err;
				}
				var column = this.table[this.current];
				if (!this.options.keepHistory) delete this.table[this.current - 1];
				var n = this.current + 1;
				var nextColumn = new Column(this.grammar, n);
				this.table.push(nextColumn);
				var literal = token.text !== void 0 ? token.text : token.value;
				var value = lexer.constructor === StreamLexer ? token.value : token;
				var scannable = column.scannable;
				for (var w = scannable.length; w--;) {
					var state = scannable[w];
					var expect = state.rule.symbols[state.dot];
					if (expect.test ? expect.test(value) : expect.type ? expect.type === token.type : expect.literal === literal) {
						var next = state.nextState({
							data: value,
							token,
							isToken: true,
							reference: n - 1
						});
						nextColumn.states.push(next);
					}
				}
				nextColumn.process();
				if (nextColumn.states.length === 0) {
					var err = new Error(this.reportError(token));
					err.offset = this.current;
					err.token = token;
					throw err;
				}
				if (this.options.keepHistory) column.lexerState = lexer.save();
				this.current++;
			}
			if (column) this.lexerState = lexer.save();
			this.results = this.finish();
			return this;
		};
		Parser.prototype.reportLexerError = function(lexerError) {
			var tokenDisplay, lexerMessage;
			var token = lexerError.token;
			if (token) {
				tokenDisplay = "input " + JSON.stringify(token.text[0]) + " (lexer error)";
				lexerMessage = this.lexer.formatError(token, "Syntax error");
			} else {
				tokenDisplay = "input (lexer error)";
				lexerMessage = lexerError.message;
			}
			return this.reportErrorCommon(lexerMessage, tokenDisplay);
		};
		Parser.prototype.reportError = function(token) {
			var tokenDisplay = (token.type ? token.type + " token: " : "") + JSON.stringify(token.value !== void 0 ? token.value : token);
			var lexerMessage = this.lexer.formatError(token, "Syntax error");
			return this.reportErrorCommon(lexerMessage, tokenDisplay);
		};
		Parser.prototype.reportErrorCommon = function(lexerMessage, tokenDisplay) {
			var lines = [];
			lines.push(lexerMessage);
			var lastColumnIndex = this.table.length - 2;
			var lastColumn = this.table[lastColumnIndex];
			var expectantStates = lastColumn.states.filter(function(state) {
				var nextSymbol = state.rule.symbols[state.dot];
				return nextSymbol && typeof nextSymbol !== "string";
			});
			if (expectantStates.length === 0) {
				lines.push("Unexpected " + tokenDisplay + ". I did not expect any more input. Here is the state of my parse table:\n");
				this.displayStateStack(lastColumn.states, lines);
			} else {
				lines.push("Unexpected " + tokenDisplay + ". Instead, I was expecting to see one of the following:\n");
				expectantStates.map(function(state) {
					return this.buildFirstStateStack(state, []) || [state];
				}, this).forEach(function(stateStack) {
					var state = stateStack[0];
					var nextSymbol = state.rule.symbols[state.dot];
					var symbolDisplay = this.getSymbolDisplay(nextSymbol);
					lines.push("A " + symbolDisplay + " based on:");
					this.displayStateStack(stateStack, lines);
				}, this);
			}
			lines.push("");
			return lines.join("\n");
		};
		Parser.prototype.displayStateStack = function(stateStack, lines) {
			var lastDisplay;
			var sameDisplayCount = 0;
			for (var j = 0; j < stateStack.length; j++) {
				var state = stateStack[j];
				var display = state.rule.toString(state.dot);
				if (display === lastDisplay) sameDisplayCount++;
				else {
					if (sameDisplayCount > 0) lines.push("    ^ " + sameDisplayCount + " more lines identical to this");
					sameDisplayCount = 0;
					lines.push("    " + display);
				}
				lastDisplay = display;
			}
		};
		Parser.prototype.getSymbolDisplay = function(symbol) {
			return getSymbolLongDisplay(symbol);
		};
		Parser.prototype.buildFirstStateStack = function(state, visited) {
			if (visited.indexOf(state) !== -1) return null;
			if (state.wantedBy.length === 0) return [state];
			var prevState = state.wantedBy[0];
			var childVisited = [state].concat(visited);
			var childResult = this.buildFirstStateStack(prevState, childVisited);
			if (childResult === null) return null;
			return [state].concat(childResult);
		};
		Parser.prototype.save = function() {
			var column = this.table[this.current];
			column.lexerState = this.lexerState;
			return column;
		};
		Parser.prototype.restore = function(column) {
			var index = column.index;
			this.current = index;
			this.table[index] = column;
			this.table.splice(index + 1);
			this.lexerState = column.lexerState;
			this.results = this.finish();
		};
		Parser.prototype.rewind = function(index) {
			if (!this.options.keepHistory) throw new Error("set option `keepHistory` to enable rewinding");
			this.restore(this.table[index]);
		};
		Parser.prototype.finish = function() {
			var considerations = [];
			var start = this.grammar.start;
			this.table[this.table.length - 1].states.forEach(function(t) {
				if (t.rule.name === start && t.dot === t.rule.symbols.length && t.reference === 0 && t.data !== Parser.fail) considerations.push(t);
			});
			return considerations.map(function(c) {
				return c.data;
			});
		};
		function getSymbolLongDisplay(symbol) {
			var type = typeof symbol;
			if (type === "string") return symbol;
			else if (type === "object") {
				if (symbol.literal) return JSON.stringify(symbol.literal);
				else if (symbol instanceof RegExp) return "character matching " + symbol;
				else if (symbol.type) return symbol.type + " token";
				else if (symbol.test) return "token matching " + String(symbol.test);
				else throw new Error("Unknown symbol type: " + symbol);
			}
		}
		function getSymbolShortDisplay(symbol) {
			var type = typeof symbol;
			if (type === "string") return symbol;
			else if (type === "object") {
				if (symbol.literal) return JSON.stringify(symbol.literal);
				else if (symbol instanceof RegExp) return symbol.toString();
				else if (symbol.type) return "%" + symbol.type;
				else if (symbol.test) return "<" + String(symbol.test) + ">";
				else throw new Error("Unknown symbol type: " + symbol);
			}
		}
		return {
			Parser,
			Grammar,
			Rule
		};
	});
}));
// ../../node_modules/.bun/sql-formatter@15.9.0/node_modules/sql-formatter/dist/esm/lexer/disambiguateTokens.js
/**
* Ensures that no keyword token (RESERVED_*) is preceded or followed by a dot (.)
* or any other property-access operator.
*
* Ensures that all RESERVED_FUNCTION_NAME tokens are followed by "(".
* If they're not, converts the token to IDENTIFIER.
*
* Converts RESERVED_DATA_TYPE tokens followed by "(" to RESERVED_PARAMETERIZED_DATA_TYPE.
*
* When IDENTIFIER or RESERVED_DATA_TYPE token is followed by "["
* converts it to ARRAY_IDENTIFIER or ARRAY_KEYWORD accordingly.
*
* Converts a reserved word after AS to IDENTIFIER when that word cannot start
* a clause there, leaving `CREATE TABLE t AS SELECT ...` alone.
*
* This is needed to avoid ambiguity in parser which expects function names
* to always be followed by open-paren, and to distinguish between
* array accessor `foo[1]` and array literal `[1, 2, 3]`.
*/
function disambiguateTokens(tokens) {
	return tokens.map(propertyNameKeywordToIdent).map(keywordAliasAfterAs).map(funcNameToIdent).map(dataTypeToParameterizedDataType).map(identToArrayIdent).map(dataTypeToArrayKeyword);
}
var propertyNameKeywordToIdent = (token, i, tokens) => {
	if (isReserved(token.type)) {
		const prevToken = prevNonCommentToken(tokens, i);
		if (prevToken && prevToken.type === TokenType.PROPERTY_ACCESS_OPERATOR) return Object.assign(Object.assign({}, token), {
			type: TokenType.IDENTIFIER,
			text: token.raw
		});
		const nextToken = nextNonCommentToken(tokens, i);
		if (nextToken && nextToken.type === TokenType.PROPERTY_ACCESS_OPERATOR) return Object.assign(Object.assign({}, token), {
			type: TokenType.IDENTIFIER,
			text: token.raw
		});
	}
	return token;
};
/**
* Some dialects allow reserved words as aliases, as in `SELECT id AS set FROM tbl`.
* Such a word is tokenized as a RESERVED_* token, which the parser then treats as
* the start of a clause. Directly after AS it can only be an alias name, so we
* convert it to IDENTIFIER.
*
* Only the token types that cannot legitimately follow AS are converted, leaving
* `CREATE TABLE t AS SELECT ...` and `PREPARE foo AS UPDATE ...` working.
*/
var keywordAliasAfterAs = (token, i, tokens) => {
	if (canBeAliasAfterAs(token)) {
		const prevToken = prevNonCommentToken(tokens, i);
		if (prevToken && isAsKeyword(prevToken)) return Object.assign(Object.assign({}, token), {
			type: TokenType.IDENTIFIER,
			text: token.raw
		});
	}
	return token;
};
var isAsKeyword = (token) => token.type === TokenType.RESERVED_KEYWORD && token.text === "AS";
var canBeAliasAfterAs = (token) => token.type === TokenType.RESERVED_SET_OPERATION || token.type === TokenType.RESERVED_JOIN || token.type === TokenType.LIMIT || token.type === TokenType.BETWEEN || token.type === TokenType.CASE || token.type === TokenType.END || token.type === TokenType.WHEN || token.type === TokenType.ELSE || token.type === TokenType.THEN || token.type === TokenType.AND || token.type === TokenType.OR || token.type === TokenType.XOR || token.type === TokenType.RESERVED_CLAUSE && token.text === "SET";
var funcNameToIdent = (token, i, tokens) => {
	if (token.type === TokenType.RESERVED_FUNCTION_NAME) {
		const nextToken = nextNonCommentToken(tokens, i);
		if (!nextToken || !isOpenParen(nextToken)) return Object.assign(Object.assign({}, token), {
			type: TokenType.IDENTIFIER,
			text: token.raw
		});
	}
	return token;
};
var dataTypeToParameterizedDataType = (token, i, tokens) => {
	if (token.type === TokenType.RESERVED_DATA_TYPE) {
		const nextToken = nextNonCommentToken(tokens, i);
		if (nextToken && isOpenParen(nextToken)) return Object.assign(Object.assign({}, token), { type: TokenType.RESERVED_PARAMETERIZED_DATA_TYPE });
	}
	return token;
};
var identToArrayIdent = (token, i, tokens) => {
	if (token.type === TokenType.IDENTIFIER) {
		const nextToken = nextNonCommentToken(tokens, i);
		if (nextToken && isOpenBracket(nextToken)) return Object.assign(Object.assign({}, token), { type: TokenType.ARRAY_IDENTIFIER });
	}
	return token;
};
var dataTypeToArrayKeyword = (token, i, tokens) => {
	if (token.type === TokenType.RESERVED_DATA_TYPE) {
		const nextToken = nextNonCommentToken(tokens, i);
		if (nextToken && isOpenBracket(nextToken)) return Object.assign(Object.assign({}, token), { type: TokenType.ARRAY_KEYWORD });
	}
	return token;
};
var prevNonCommentToken = (tokens, index) => nextNonCommentToken(tokens, index, -1);
var nextNonCommentToken = (tokens, index, dir = 1) => {
	let i = 1;
	while (tokens[index + i * dir] && isComment(tokens[index + i * dir])) i++;
	return tokens[index + i * dir];
};
var isOpenParen = (t) => t.type === TokenType.OPEN_PAREN && t.text === "(";
var isOpenBracket = (t) => t.type === TokenType.OPEN_PAREN && t.text === "[";
var isComment = (t) => t.type === TokenType.BLOCK_COMMENT || t.type === TokenType.LINE_COMMENT;
// ../../node_modules/.bun/sql-formatter@15.9.0/node_modules/sql-formatter/dist/esm/parser/LexerAdapter.js
var LexerAdapter = class {
	constructor(tokenize) {
		this.tokenize = tokenize;
		this.index = 0;
		this.tokens = [];
		this.input = "";
	}
	reset(chunk, _info) {
		this.input = chunk;
		this.index = 0;
		this.tokens = this.tokenize(chunk);
	}
	next() {
		return this.tokens[this.index++];
	}
	save() {}
	formatError(token) {
		const { line, col } = lineColFromIndex(this.input, token.start);
		return `Parse error at token: ${token.text} at line ${line} column ${col}`;
	}
	has(name) {
		return name in TokenType;
	}
};
// ../../node_modules/.bun/sql-formatter@15.9.0/node_modules/sql-formatter/dist/esm/parser/ast.js
var NodeType;
(function(NodeType) {
	NodeType["statement"] = "statement";
	NodeType["clause"] = "clause";
	NodeType["set_operation"] = "set_operation";
	NodeType["function_call"] = "function_call";
	NodeType["parameterized_data_type"] = "parameterized_data_type";
	NodeType["array_subscript"] = "array_subscript";
	NodeType["property_access"] = "property_access";
	NodeType["parenthesis"] = "parenthesis";
	NodeType["between_predicate"] = "between_predicate";
	NodeType["case_expression"] = "case_expression";
	NodeType["case_when"] = "case_when";
	NodeType["case_else"] = "case_else";
	NodeType["limit_clause"] = "limit_clause";
	NodeType["all_columns_asterisk"] = "all_columns_asterisk";
	NodeType["literal"] = "literal";
	NodeType["identifier"] = "identifier";
	NodeType["keyword"] = "keyword";
	NodeType["data_type"] = "data_type";
	NodeType["parameter"] = "parameter";
	NodeType["operator"] = "operator";
	NodeType["comma"] = "comma";
	NodeType["line_comment"] = "line_comment";
	NodeType["block_comment"] = "block_comment";
	NodeType["disable_comment"] = "disable_comment";
})(NodeType = NodeType || (NodeType = {}));
// ../../node_modules/.bun/sql-formatter@15.9.0/node_modules/sql-formatter/dist/esm/parser/grammar.js
function id(d) {
	return d[0];
}
var lexer = new LexerAdapter((chunk) => []);
var unwrap = ([[el]]) => el;
var toKeywordNode = (token) => ({
	type: NodeType.keyword,
	tokenType: token.type,
	text: token.text,
	raw: token.raw
});
var toDataTypeNode = (token) => ({
	type: NodeType.data_type,
	text: token.text,
	raw: token.raw
});
var materializeExpressionList = (expressions) => {
	const result = [];
	for (let current = expressions; current; current = current.previous) result.push(current.value);
	result.reverse();
	return result;
};
var addComments = (node, { leading, trailing }) => {
	if (leading === null || leading === void 0 ? void 0 : leading.length) node = Object.assign(Object.assign({}, node), { leadingComments: leading });
	if (trailing === null || trailing === void 0 ? void 0 : trailing.length) node = Object.assign(Object.assign({}, node), { trailingComments: trailing });
	return node;
};
var addCommentsToArray = (nodes, { leading, trailing }) => {
	if (leading === null || leading === void 0 ? void 0 : leading.length) {
		const [first, ...rest] = nodes;
		nodes = [addComments(first, { leading }), ...rest];
	}
	if (trailing === null || trailing === void 0 ? void 0 : trailing.length) {
		const lead = nodes.slice(0, -1);
		const last = nodes[nodes.length - 1];
		nodes = [...lead, addComments(last, { trailing })];
	}
	return nodes;
};
var grammar = {
	Lexer: lexer,
	ParserRules: [
		{
			"name": "main$ebnf$1",
			"symbols": []
		},
		{
			"name": "main$ebnf$1",
			"symbols": ["main$ebnf$1", "statement"],
			"postprocess": (d) => d[0].concat([d[1]])
		},
		{
			"name": "main",
			"symbols": ["main$ebnf$1"],
			"postprocess": ([statements]) => {
				const last = statements[statements.length - 1];
				if (last && !last.hasSemicolon) return last.children.length > 0 ? statements : statements.slice(0, -1);
				else return statements;
			}
		},
		{
			"name": "statement$subexpression$1",
			"symbols": [lexer.has("DELIMITER") ? { type: "DELIMITER" } : DELIMITER]
		},
		{
			"name": "statement$subexpression$1",
			"symbols": [lexer.has("EOF") ? { type: "EOF" } : EOF]
		},
		{
			"name": "statement",
			"symbols": ["expressions_or_clauses", "statement$subexpression$1"],
			"postprocess": ([children, [delimiter]]) => ({
				type: NodeType.statement,
				children: materializeExpressionList(children),
				hasSemicolon: delimiter.type === TokenType.DELIMITER
			})
		},
		{
			"name": "expressions_or_clauses",
			"symbols": ["expression_list"],
			"postprocess": id
		},
		{
			"name": "expressions_or_clauses",
			"symbols": ["expressions_or_clauses", "clause"],
			"postprocess": ([previous, value]) => ({
				previous,
				value
			})
		},
		{
			"name": "expression_list",
			"symbols": [],
			"postprocess": () => void 0
		},
		{
			"name": "expression_list",
			"symbols": ["expression_list", "free_form_sql"],
			"postprocess": ([previous, value]) => ({
				previous,
				value
			})
		},
		{
			"name": "clause$subexpression$1",
			"symbols": ["limit_clause"]
		},
		{
			"name": "clause$subexpression$1",
			"symbols": ["select_clause"]
		},
		{
			"name": "clause$subexpression$1",
			"symbols": ["other_clause"]
		},
		{
			"name": "clause$subexpression$1",
			"symbols": ["set_operation"]
		},
		{
			"name": "clause",
			"symbols": ["clause$subexpression$1"],
			"postprocess": unwrap
		},
		{
			"name": "limit_clause$ebnf$1$subexpression$1$ebnf$1",
			"symbols": ["free_form_sql"]
		},
		{
			"name": "limit_clause$ebnf$1$subexpression$1$ebnf$1",
			"symbols": ["limit_clause$ebnf$1$subexpression$1$ebnf$1", "free_form_sql"],
			"postprocess": (d) => d[0].concat([d[1]])
		},
		{
			"name": "limit_clause$ebnf$1$subexpression$1",
			"symbols": [lexer.has("COMMA") ? { type: "COMMA" } : COMMA, "limit_clause$ebnf$1$subexpression$1$ebnf$1"]
		},
		{
			"name": "limit_clause$ebnf$1",
			"symbols": ["limit_clause$ebnf$1$subexpression$1"],
			"postprocess": id
		},
		{
			"name": "limit_clause$ebnf$1",
			"symbols": [],
			"postprocess": () => null
		},
		{
			"name": "limit_clause",
			"symbols": [
				lexer.has("LIMIT") ? { type: "LIMIT" } : LIMIT,
				"_",
				"expression_chain_",
				"limit_clause$ebnf$1"
			],
			"postprocess": ([limitToken, _, exp1, optional]) => {
				if (optional) {
					const [comma, exp2] = optional;
					return {
						type: NodeType.limit_clause,
						limitKw: addComments(toKeywordNode(limitToken), { trailing: _ }),
						offset: exp1,
						count: exp2
					};
				} else return {
					type: NodeType.limit_clause,
					limitKw: addComments(toKeywordNode(limitToken), { trailing: _ }),
					count: exp1
				};
			}
		},
		{
			"name": "select_clause$subexpression$1",
			"symbols": ["all_columns_asterisk", "expression_list"]
		},
		{
			"name": "select_clause$subexpression$1",
			"symbols": ["asteriskless_free_form_sql", "expression_list"]
		},
		{
			"name": "select_clause",
			"symbols": [lexer.has("RESERVED_SELECT") ? { type: "RESERVED_SELECT" } : RESERVED_SELECT, "select_clause$subexpression$1"],
			"postprocess": ([nameToken, [exp, expressions]]) => ({
				type: NodeType.clause,
				nameKw: toKeywordNode(nameToken),
				get children() {
					return [exp, ...materializeExpressionList(expressions)];
				}
			})
		},
		{
			"name": "select_clause",
			"symbols": [lexer.has("RESERVED_SELECT") ? { type: "RESERVED_SELECT" } : RESERVED_SELECT],
			"postprocess": ([nameToken]) => ({
				type: NodeType.clause,
				nameKw: toKeywordNode(nameToken),
				children: []
			})
		},
		{
			"name": "all_columns_asterisk",
			"symbols": [lexer.has("ASTERISK") ? { type: "ASTERISK" } : ASTERISK],
			"postprocess": () => ({ type: NodeType.all_columns_asterisk })
		},
		{
			"name": "other_clause",
			"symbols": [lexer.has("RESERVED_CLAUSE") ? { type: "RESERVED_CLAUSE" } : RESERVED_CLAUSE, "expression_list"],
			"postprocess": ([nameToken, children]) => ({
				type: NodeType.clause,
				nameKw: toKeywordNode(nameToken),
				get children() {
					return materializeExpressionList(children);
				}
			})
		},
		{
			"name": "set_operation",
			"symbols": [lexer.has("RESERVED_SET_OPERATION") ? { type: "RESERVED_SET_OPERATION" } : RESERVED_SET_OPERATION, "expression_list"],
			"postprocess": ([nameToken, children]) => ({
				type: NodeType.set_operation,
				nameKw: toKeywordNode(nameToken),
				get children() {
					return materializeExpressionList(children);
				}
			})
		},
		{
			"name": "expression_chain_$ebnf$1",
			"symbols": ["expression_with_comments_"]
		},
		{
			"name": "expression_chain_$ebnf$1",
			"symbols": ["expression_chain_$ebnf$1", "expression_with_comments_"],
			"postprocess": (d) => d[0].concat([d[1]])
		},
		{
			"name": "expression_chain_",
			"symbols": ["expression_chain_$ebnf$1"],
			"postprocess": id
		},
		{
			"name": "expression_chain$ebnf$1",
			"symbols": []
		},
		{
			"name": "expression_chain$ebnf$1",
			"symbols": ["expression_chain$ebnf$1", "_expression_with_comments"],
			"postprocess": (d) => d[0].concat([d[1]])
		},
		{
			"name": "expression_chain",
			"symbols": ["expression", "expression_chain$ebnf$1"],
			"postprocess": ([expr, chain]) => [expr, ...chain]
		},
		{
			"name": "andless_expression_chain$ebnf$1",
			"symbols": []
		},
		{
			"name": "andless_expression_chain$ebnf$1",
			"symbols": ["andless_expression_chain$ebnf$1", "_andless_expression_with_comments"],
			"postprocess": (d) => d[0].concat([d[1]])
		},
		{
			"name": "andless_expression_chain",
			"symbols": ["andless_expression", "andless_expression_chain$ebnf$1"],
			"postprocess": ([expr, chain]) => [expr, ...chain]
		},
		{
			"name": "expression_with_comments_",
			"symbols": ["expression", "_"],
			"postprocess": ([expr, _]) => addComments(expr, { trailing: _ })
		},
		{
			"name": "_expression_with_comments",
			"symbols": ["_", "expression"],
			"postprocess": ([_, expr]) => addComments(expr, { leading: _ })
		},
		{
			"name": "_andless_expression_with_comments",
			"symbols": ["_", "andless_expression"],
			"postprocess": ([_, expr]) => addComments(expr, { leading: _ })
		},
		{
			"name": "free_form_sql$subexpression$1",
			"symbols": ["asteriskless_free_form_sql"]
		},
		{
			"name": "free_form_sql$subexpression$1",
			"symbols": ["asterisk"]
		},
		{
			"name": "free_form_sql",
			"symbols": ["free_form_sql$subexpression$1"],
			"postprocess": unwrap
		},
		{
			"name": "asteriskless_free_form_sql$subexpression$1",
			"symbols": ["asteriskless_andless_expression"]
		},
		{
			"name": "asteriskless_free_form_sql$subexpression$1",
			"symbols": ["logic_operator"]
		},
		{
			"name": "asteriskless_free_form_sql$subexpression$1",
			"symbols": ["comma"]
		},
		{
			"name": "asteriskless_free_form_sql$subexpression$1",
			"symbols": ["comment"]
		},
		{
			"name": "asteriskless_free_form_sql$subexpression$1",
			"symbols": ["other_keyword"]
		},
		{
			"name": "asteriskless_free_form_sql",
			"symbols": ["asteriskless_free_form_sql$subexpression$1"],
			"postprocess": unwrap
		},
		{
			"name": "expression$subexpression$1",
			"symbols": ["andless_expression"]
		},
		{
			"name": "expression$subexpression$1",
			"symbols": ["logic_operator"]
		},
		{
			"name": "expression",
			"symbols": ["expression$subexpression$1"],
			"postprocess": unwrap
		},
		{
			"name": "andless_expression$subexpression$1",
			"symbols": ["asteriskless_andless_expression"]
		},
		{
			"name": "andless_expression$subexpression$1",
			"symbols": ["asterisk"]
		},
		{
			"name": "andless_expression",
			"symbols": ["andless_expression$subexpression$1"],
			"postprocess": unwrap
		},
		{
			"name": "asteriskless_andless_expression$subexpression$1",
			"symbols": ["atomic_expression"]
		},
		{
			"name": "asteriskless_andless_expression$subexpression$1",
			"symbols": ["between_predicate"]
		},
		{
			"name": "asteriskless_andless_expression$subexpression$1",
			"symbols": ["case_expression"]
		},
		{
			"name": "asteriskless_andless_expression",
			"symbols": ["asteriskless_andless_expression$subexpression$1"],
			"postprocess": unwrap
		},
		{
			"name": "atomic_expression$subexpression$1",
			"symbols": ["array_subscript"]
		},
		{
			"name": "atomic_expression$subexpression$1",
			"symbols": ["function_call"]
		},
		{
			"name": "atomic_expression$subexpression$1",
			"symbols": ["property_access"]
		},
		{
			"name": "atomic_expression$subexpression$1",
			"symbols": ["parenthesis"]
		},
		{
			"name": "atomic_expression$subexpression$1",
			"symbols": ["curly_braces"]
		},
		{
			"name": "atomic_expression$subexpression$1",
			"symbols": ["square_brackets"]
		},
		{
			"name": "atomic_expression$subexpression$1",
			"symbols": ["operator"]
		},
		{
			"name": "atomic_expression$subexpression$1",
			"symbols": ["identifier"]
		},
		{
			"name": "atomic_expression$subexpression$1",
			"symbols": ["parameter"]
		},
		{
			"name": "atomic_expression$subexpression$1",
			"symbols": ["literal"]
		},
		{
			"name": "atomic_expression$subexpression$1",
			"symbols": ["data_type"]
		},
		{
			"name": "atomic_expression$subexpression$1",
			"symbols": ["keyword"]
		},
		{
			"name": "atomic_expression",
			"symbols": ["atomic_expression$subexpression$1"],
			"postprocess": unwrap
		},
		{
			"name": "array_subscript",
			"symbols": [
				lexer.has("ARRAY_IDENTIFIER") ? { type: "ARRAY_IDENTIFIER" } : ARRAY_IDENTIFIER,
				"_",
				"square_brackets"
			],
			"postprocess": ([arrayToken, _, brackets]) => ({
				type: NodeType.array_subscript,
				array: addComments({
					type: NodeType.identifier,
					quoted: false,
					text: arrayToken.text
				}, { trailing: _ }),
				parenthesis: brackets
			})
		},
		{
			"name": "array_subscript",
			"symbols": [
				lexer.has("ARRAY_KEYWORD") ? { type: "ARRAY_KEYWORD" } : ARRAY_KEYWORD,
				"_",
				"square_brackets"
			],
			"postprocess": ([arrayToken, _, brackets]) => ({
				type: NodeType.array_subscript,
				array: addComments(toKeywordNode(arrayToken), { trailing: _ }),
				parenthesis: brackets
			})
		},
		{
			"name": "function_call",
			"symbols": [
				lexer.has("RESERVED_FUNCTION_NAME") ? { type: "RESERVED_FUNCTION_NAME" } : RESERVED_FUNCTION_NAME,
				"_",
				"parenthesis"
			],
			"postprocess": ([nameToken, _, parens]) => ({
				type: NodeType.function_call,
				nameKw: addComments(toKeywordNode(nameToken), { trailing: _ }),
				parenthesis: parens
			})
		},
		{
			"name": "parenthesis",
			"symbols": [
				{ "literal": "(" },
				"expressions_or_clauses",
				{ "literal": ")" }
			],
			"postprocess": ([open, children, close]) => ({
				type: NodeType.parenthesis,
				children: materializeExpressionList(children),
				openParen: "(",
				closeParen: ")"
			})
		},
		{
			"name": "curly_braces",
			"symbols": [
				{ "literal": "{" },
				"expression_list",
				{ "literal": "}" }
			],
			"postprocess": ([open, children, close]) => ({
				type: NodeType.parenthesis,
				children: materializeExpressionList(children),
				openParen: "{",
				closeParen: "}"
			})
		},
		{
			"name": "square_brackets",
			"symbols": [
				{ "literal": "[" },
				"expression_list",
				{ "literal": "]" }
			],
			"postprocess": ([open, children, close]) => ({
				type: NodeType.parenthesis,
				children: materializeExpressionList(children),
				openParen: "[",
				closeParen: "]"
			})
		},
		{
			"name": "property_access$subexpression$1",
			"symbols": ["identifier"]
		},
		{
			"name": "property_access$subexpression$1",
			"symbols": ["array_subscript"]
		},
		{
			"name": "property_access$subexpression$1",
			"symbols": ["all_columns_asterisk"]
		},
		{
			"name": "property_access$subexpression$1",
			"symbols": ["parameter"]
		},
		{
			"name": "property_access",
			"symbols": [
				"atomic_expression",
				"_",
				lexer.has("PROPERTY_ACCESS_OPERATOR") ? { type: "PROPERTY_ACCESS_OPERATOR" } : PROPERTY_ACCESS_OPERATOR,
				"_",
				"property_access$subexpression$1"
			],
			"postprocess": ([object, _1, dot, _2, [property]]) => {
				return {
					type: NodeType.property_access,
					object: addComments(object, { trailing: _1 }),
					operator: dot.text,
					property: addComments(property, { leading: _2 })
				};
			}
		},
		{
			"name": "between_predicate",
			"symbols": [
				lexer.has("BETWEEN") ? { type: "BETWEEN" } : BETWEEN,
				"_",
				"andless_expression_chain",
				"_",
				lexer.has("AND") ? { type: "AND" } : AND,
				"_",
				"andless_expression"
			],
			"postprocess": ([betweenToken, _1, expr1, _2, andToken, _3, expr2]) => ({
				type: NodeType.between_predicate,
				betweenKw: toKeywordNode(betweenToken),
				expr1: addCommentsToArray(expr1, {
					leading: _1,
					trailing: _2
				}),
				andKw: toKeywordNode(andToken),
				expr2: [addComments(expr2, { leading: _3 })]
			})
		},
		{
			"name": "case_expression$ebnf$1",
			"symbols": ["expression_chain_"],
			"postprocess": id
		},
		{
			"name": "case_expression$ebnf$1",
			"symbols": [],
			"postprocess": () => null
		},
		{
			"name": "case_expression$ebnf$2",
			"symbols": []
		},
		{
			"name": "case_expression$ebnf$2",
			"symbols": ["case_expression$ebnf$2", "case_clause"],
			"postprocess": (d) => d[0].concat([d[1]])
		},
		{
			"name": "case_expression",
			"symbols": [
				lexer.has("CASE") ? { type: "CASE" } : CASE,
				"_",
				"case_expression$ebnf$1",
				"case_expression$ebnf$2",
				lexer.has("END") ? { type: "END" } : END
			],
			"postprocess": ([caseToken, _, expr, clauses, endToken]) => ({
				type: NodeType.case_expression,
				caseKw: addComments(toKeywordNode(caseToken), { trailing: _ }),
				endKw: toKeywordNode(endToken),
				expr: expr || [],
				clauses
			})
		},
		{
			"name": "case_clause",
			"symbols": [
				lexer.has("WHEN") ? { type: "WHEN" } : WHEN,
				"_",
				"expression_chain_",
				lexer.has("THEN") ? { type: "THEN" } : THEN,
				"_",
				"expression_chain_"
			],
			"postprocess": ([whenToken, _1, cond, thenToken, _2, expr]) => ({
				type: NodeType.case_when,
				whenKw: addComments(toKeywordNode(whenToken), { trailing: _1 }),
				thenKw: addComments(toKeywordNode(thenToken), { trailing: _2 }),
				condition: cond,
				result: expr
			})
		},
		{
			"name": "case_clause",
			"symbols": [
				lexer.has("ELSE") ? { type: "ELSE" } : ELSE,
				"_",
				"expression_chain_"
			],
			"postprocess": ([elseToken, _, expr]) => ({
				type: NodeType.case_else,
				elseKw: addComments(toKeywordNode(elseToken), { trailing: _ }),
				result: expr
			})
		},
		{
			"name": "comma$subexpression$1",
			"symbols": [lexer.has("COMMA") ? { type: "COMMA" } : COMMA]
		},
		{
			"name": "comma",
			"symbols": ["comma$subexpression$1"],
			"postprocess": ([[token]]) => ({ type: NodeType.comma })
		},
		{
			"name": "asterisk$subexpression$1",
			"symbols": [lexer.has("ASTERISK") ? { type: "ASTERISK" } : ASTERISK]
		},
		{
			"name": "asterisk",
			"symbols": ["asterisk$subexpression$1"],
			"postprocess": ([[token]]) => ({
				type: NodeType.operator,
				text: token.text
			})
		},
		{
			"name": "operator$subexpression$1",
			"symbols": [lexer.has("OPERATOR") ? { type: "OPERATOR" } : OPERATOR]
		},
		{
			"name": "operator",
			"symbols": ["operator$subexpression$1"],
			"postprocess": ([[token]]) => ({
				type: NodeType.operator,
				text: token.text
			})
		},
		{
			"name": "identifier$subexpression$1",
			"symbols": [lexer.has("IDENTIFIER") ? { type: "IDENTIFIER" } : IDENTIFIER]
		},
		{
			"name": "identifier$subexpression$1",
			"symbols": [lexer.has("QUOTED_IDENTIFIER") ? { type: "QUOTED_IDENTIFIER" } : QUOTED_IDENTIFIER]
		},
		{
			"name": "identifier$subexpression$1",
			"symbols": [lexer.has("VARIABLE") ? { type: "VARIABLE" } : VARIABLE]
		},
		{
			"name": "identifier",
			"symbols": ["identifier$subexpression$1"],
			"postprocess": ([[token]]) => ({
				type: NodeType.identifier,
				quoted: token.type !== "IDENTIFIER",
				text: token.text
			})
		},
		{
			"name": "parameter$subexpression$1",
			"symbols": [lexer.has("NAMED_PARAMETER") ? { type: "NAMED_PARAMETER" } : NAMED_PARAMETER]
		},
		{
			"name": "parameter$subexpression$1",
			"symbols": [lexer.has("QUOTED_PARAMETER") ? { type: "QUOTED_PARAMETER" } : QUOTED_PARAMETER]
		},
		{
			"name": "parameter$subexpression$1",
			"symbols": [lexer.has("NUMBERED_PARAMETER") ? { type: "NUMBERED_PARAMETER" } : NUMBERED_PARAMETER]
		},
		{
			"name": "parameter$subexpression$1",
			"symbols": [lexer.has("POSITIONAL_PARAMETER") ? { type: "POSITIONAL_PARAMETER" } : POSITIONAL_PARAMETER]
		},
		{
			"name": "parameter$subexpression$1",
			"symbols": [lexer.has("CUSTOM_PARAMETER") ? { type: "CUSTOM_PARAMETER" } : CUSTOM_PARAMETER]
		},
		{
			"name": "parameter",
			"symbols": ["parameter$subexpression$1"],
			"postprocess": ([[token]]) => ({
				type: NodeType.parameter,
				key: token.key,
				text: token.text
			})
		},
		{
			"name": "literal$subexpression$1",
			"symbols": [lexer.has("NUMBER") ? { type: "NUMBER" } : NUMBER]
		},
		{
			"name": "literal$subexpression$1",
			"symbols": [lexer.has("STRING") ? { type: "STRING" } : STRING]
		},
		{
			"name": "literal",
			"symbols": ["literal$subexpression$1"],
			"postprocess": ([[token]]) => ({
				type: NodeType.literal,
				text: token.text
			})
		},
		{
			"name": "keyword$subexpression$1",
			"symbols": [lexer.has("RESERVED_KEYWORD") ? { type: "RESERVED_KEYWORD" } : RESERVED_KEYWORD]
		},
		{
			"name": "keyword$subexpression$1",
			"symbols": [lexer.has("RESERVED_KEYWORD_PHRASE") ? { type: "RESERVED_KEYWORD_PHRASE" } : RESERVED_KEYWORD_PHRASE]
		},
		{
			"name": "keyword$subexpression$1",
			"symbols": [lexer.has("RESERVED_JOIN") ? { type: "RESERVED_JOIN" } : RESERVED_JOIN]
		},
		{
			"name": "keyword",
			"symbols": ["keyword$subexpression$1"],
			"postprocess": ([[token]]) => toKeywordNode(token)
		},
		{
			"name": "data_type$subexpression$1",
			"symbols": [lexer.has("RESERVED_DATA_TYPE") ? { type: "RESERVED_DATA_TYPE" } : RESERVED_DATA_TYPE]
		},
		{
			"name": "data_type$subexpression$1",
			"symbols": [lexer.has("RESERVED_DATA_TYPE_PHRASE") ? { type: "RESERVED_DATA_TYPE_PHRASE" } : RESERVED_DATA_TYPE_PHRASE]
		},
		{
			"name": "data_type",
			"symbols": ["data_type$subexpression$1"],
			"postprocess": ([[token]]) => toDataTypeNode(token)
		},
		{
			"name": "data_type",
			"symbols": [
				lexer.has("RESERVED_PARAMETERIZED_DATA_TYPE") ? { type: "RESERVED_PARAMETERIZED_DATA_TYPE" } : RESERVED_PARAMETERIZED_DATA_TYPE,
				"_",
				"parenthesis"
			],
			"postprocess": ([nameToken, _, parens]) => ({
				type: NodeType.parameterized_data_type,
				dataType: addComments(toDataTypeNode(nameToken), { trailing: _ }),
				parenthesis: parens
			})
		},
		{
			"name": "logic_operator$subexpression$1",
			"symbols": [lexer.has("AND") ? { type: "AND" } : AND]
		},
		{
			"name": "logic_operator$subexpression$1",
			"symbols": [lexer.has("OR") ? { type: "OR" } : OR]
		},
		{
			"name": "logic_operator$subexpression$1",
			"symbols": [lexer.has("XOR") ? { type: "XOR" } : XOR]
		},
		{
			"name": "logic_operator",
			"symbols": ["logic_operator$subexpression$1"],
			"postprocess": ([[token]]) => toKeywordNode(token)
		},
		{
			"name": "other_keyword$subexpression$1",
			"symbols": [lexer.has("WHEN") ? { type: "WHEN" } : WHEN]
		},
		{
			"name": "other_keyword$subexpression$1",
			"symbols": [lexer.has("THEN") ? { type: "THEN" } : THEN]
		},
		{
			"name": "other_keyword$subexpression$1",
			"symbols": [lexer.has("ELSE") ? { type: "ELSE" } : ELSE]
		},
		{
			"name": "other_keyword$subexpression$1",
			"symbols": [lexer.has("END") ? { type: "END" } : END]
		},
		{
			"name": "other_keyword",
			"symbols": ["other_keyword$subexpression$1"],
			"postprocess": ([[token]]) => toKeywordNode(token)
		},
		{
			"name": "_$ebnf$1",
			"symbols": []
		},
		{
			"name": "_$ebnf$1",
			"symbols": ["_$ebnf$1", "comment"],
			"postprocess": (d) => d[0].concat([d[1]])
		},
		{
			"name": "_",
			"symbols": ["_$ebnf$1"],
			"postprocess": ([comments]) => comments
		},
		{
			"name": "comment",
			"symbols": [lexer.has("LINE_COMMENT") ? { type: "LINE_COMMENT" } : LINE_COMMENT],
			"postprocess": ([token]) => ({
				type: NodeType.line_comment,
				text: token.text,
				precedingWhitespace: token.precedingWhitespace
			})
		},
		{
			"name": "comment",
			"symbols": [lexer.has("BLOCK_COMMENT") ? { type: "BLOCK_COMMENT" } : BLOCK_COMMENT],
			"postprocess": ([token]) => ({
				type: NodeType.block_comment,
				text: token.text,
				precedingWhitespace: token.precedingWhitespace
			})
		},
		{
			"name": "comment",
			"symbols": [lexer.has("DISABLE_COMMENT") ? { type: "DISABLE_COMMENT" } : DISABLE_COMMENT],
			"postprocess": ([token]) => ({
				type: NodeType.disable_comment,
				text: token.text,
				precedingWhitespace: token.precedingWhitespace
			})
		}
	],
	ParserStart: "main"
};
var { Parser: NearleyParser, Grammar } = (/* @__PURE__ */ __toESM(require_nearley(), 1)).default;
/**
* Creates a parser object which wraps the setup of Nearley parser
*/
function createParser(tokenizer) {
	let paramTypesOverrides = {};
	const lexer = new LexerAdapter((chunk) => [...disambiguateTokens(tokenizer.tokenize(chunk, paramTypesOverrides)), createEofToken(chunk.length)]);
	const parser = new NearleyParser(Grammar.fromCompiled(grammar), { lexer });
	return { parse: (sql, paramTypes) => {
		paramTypesOverrides = paramTypes;
		const { results } = parser.feed(sql);
		if (results.length === 1) return results[0];
		else if (results.length === 0) throw new Error("Parse error: Invalid SQL");
		else throw new Error(`Parse error: Ambiguous grammar\n${JSON.stringify(results, void 0, 2)}`);
	} };
}
// ../../node_modules/.bun/sql-formatter@15.9.0/node_modules/sql-formatter/dist/esm/formatter/Layout.js
/** Whitespace modifiers to be used with add() method */
var WS;
(function(WS) {
	WS[WS["SPACE"] = 0] = "SPACE";
	WS[WS["NO_SPACE"] = 1] = "NO_SPACE";
	WS[WS["NO_NEWLINE"] = 2] = "NO_NEWLINE";
	WS[WS["NEWLINE"] = 3] = "NEWLINE";
	WS[WS["MANDATORY_NEWLINE"] = 4] = "MANDATORY_NEWLINE";
	WS[WS["INDENT"] = 5] = "INDENT";
	WS[WS["SINGLE_INDENT"] = 6] = "SINGLE_INDENT";
})(WS = WS || (WS = {}));
/**
* API for constructing SQL string (especially the whitespace part).
*
* It hides the internal implementation.
* Originally it used plain string concatenation, which was expensive.
* Now it's storing items to array and builds the string only in the end.
*/
var Layout = class {
	constructor(indentation) {
		this.indentation = indentation;
		this.items = [];
	}
	/**
	* Appends token strings and whitespace modifications to SQL string.
	*/
	add(...items) {
		for (const item of items) switch (item) {
			case WS.SPACE:
				this.items.push(WS.SPACE);
				break;
			case WS.NO_SPACE:
				this.trimHorizontalWhitespace();
				break;
			case WS.NO_NEWLINE:
				this.trimWhitespace();
				break;
			case WS.NEWLINE:
				this.trimHorizontalWhitespace();
				this.addNewline(WS.NEWLINE);
				break;
			case WS.MANDATORY_NEWLINE:
				this.trimHorizontalWhitespace();
				this.addNewline(WS.MANDATORY_NEWLINE);
				break;
			case WS.INDENT:
				this.addIndentation();
				break;
			case WS.SINGLE_INDENT:
				this.items.push(WS.SINGLE_INDENT);
				break;
			default:
				if (item.startsWith("-") && this.lastItemEndsWith("-")) this.items.push(WS.SPACE);
				this.items.push(item);
		}
	}
	lastItemEndsWith(suffix) {
		const lastItem = last(this.items);
		return typeof lastItem === "string" && lastItem.endsWith(suffix);
	}
	trimHorizontalWhitespace() {
		while (isHorizontalWhitespace(last(this.items))) this.items.pop();
	}
	trimWhitespace() {
		while (isRemovableWhitespace(last(this.items))) this.items.pop();
	}
	addNewline(newline) {
		if (this.items.length > 0) switch (last(this.items)) {
			case WS.NEWLINE:
				this.items.pop();
				this.items.push(newline);
				break;
			case WS.MANDATORY_NEWLINE: break;
			default: this.items.push(newline);
		}
	}
	addIndentation() {
		for (let i = 0; i < this.indentation.getLevel(); i++) this.items.push(WS.SINGLE_INDENT);
	}
	/**
	* Returns the final SQL string.
	*/
	toString() {
		return this.items.map((item) => this.itemToString(item)).join("");
	}
	/**
	* Returns the internal layout data
	*/
	getLayoutItems() {
		return this.items;
	}
	/**
	* True when some content has already been added and nothing but indentation
	* has been emitted since the last newline, meaning the next token would be
	* placed at the start of a fresh (non-first) line.
	*/
	isAtStartOfLine() {
		for (let i = this.items.length - 1; i >= 0; i--) {
			const item = this.items[i];
			if (item === WS.SINGLE_INDENT) continue;
			return item === WS.NEWLINE || item === WS.MANDATORY_NEWLINE;
		}
		return false;
	}
	itemToString(item) {
		switch (item) {
			case WS.SPACE: return " ";
			case WS.NEWLINE:
			case WS.MANDATORY_NEWLINE: return "\n";
			case WS.SINGLE_INDENT: return this.indentation.getSingleIndent();
			default: return item;
		}
	}
};
var isHorizontalWhitespace = (item) => item === WS.SPACE || item === WS.SINGLE_INDENT;
var isRemovableWhitespace = (item) => item === WS.SPACE || item === WS.SINGLE_INDENT || item === WS.NEWLINE;
// ../../node_modules/.bun/sql-formatter@15.9.0/node_modules/sql-formatter/dist/esm/formatter/tabularStyle.js
/**
* When tabular style enabled,
* produces a 10-char wide version of token text.
*/
function toTabularFormat(tokenText, indentStyle) {
	if (indentStyle === "standard") return tokenText;
	let tail = [];
	if (tokenText.length >= 10 && tokenText.includes(" ")) [tokenText, ...tail] = tokenText.split(" ");
	if (indentStyle === "tabularLeft") tokenText = tokenText.padEnd(9, " ");
	else tokenText = tokenText.padStart(9, " ");
	return tokenText + ["", ...tail].join(" ");
}
/**
* True when the token can be formatted in tabular style
*/
function isTabularToken(type) {
	return isLogicalOperator(type) || type === TokenType.RESERVED_CLAUSE || type === TokenType.RESERVED_SELECT || type === TokenType.RESERVED_SET_OPERATION || type === TokenType.RESERVED_JOIN || type === TokenType.LIMIT;
}
// ../../node_modules/.bun/sql-formatter@15.9.0/node_modules/sql-formatter/dist/esm/formatter/Indentation.js
var INDENT_TYPE_TOP_LEVEL = "top-level";
var INDENT_TYPE_BLOCK_LEVEL = "block-level";
/**
* Manages indentation levels.
*
* There are two types of indentation levels:
*
* - BLOCK_LEVEL : increased by open-parenthesis
* - TOP_LEVEL : increased by RESERVED_CLAUSE words
*/
var Indentation = class {
	/**
	* @param {string} indent A string to indent with
	*/
	constructor(indent) {
		this.indent = indent;
		this.indentTypes = [];
	}
	/**
	* Returns indentation string for single indentation step.
	*/
	getSingleIndent() {
		return this.indent;
	}
	/**
	* Returns current indentation level
	*/
	getLevel() {
		return this.indentTypes.length;
	}
	/**
	* Increases indentation by one top-level indent.
	*/
	increaseTopLevel() {
		this.indentTypes.push(INDENT_TYPE_TOP_LEVEL);
	}
	/**
	* Increases indentation by one block-level indent.
	*/
	increaseBlockLevel() {
		this.indentTypes.push(INDENT_TYPE_BLOCK_LEVEL);
	}
	/**
	* Decreases indentation by one top-level indent.
	* Does nothing when the previous indent is not top-level.
	*/
	decreaseTopLevel() {
		if (this.indentTypes.length > 0 && last(this.indentTypes) === INDENT_TYPE_TOP_LEVEL) this.indentTypes.pop();
	}
	/**
	* Decreases indentation by one block-level indent.
	* If there are top-level indents within the block-level indent,
	* throws away these as well.
	*/
	decreaseBlockLevel() {
		while (this.indentTypes.length > 0) if (this.indentTypes.pop() !== INDENT_TYPE_TOP_LEVEL) break;
	}
};
// ../../node_modules/.bun/sql-formatter@15.9.0/node_modules/sql-formatter/dist/esm/formatter/InlineLayout.js
/**
* Like Layout, but only formats single-line expressions.
*
* Throws InlineLayoutError:
* - when encountering a newline
* - when exceeding configured expressionWidth
*/
var InlineLayout = class extends Layout {
	constructor(expressionWidth) {
		super(new Indentation(""));
		this.expressionWidth = expressionWidth;
		this.length = 0;
		this.trailingSpace = false;
	}
	add(...items) {
		items.forEach((item) => this.addToLength(item));
		if (this.length > this.expressionWidth) throw new InlineLayoutError();
		super.add(...items);
	}
	addToLength(item) {
		if (typeof item === "string") {
			this.length += item.length;
			this.trailingSpace = false;
		} else if (item === WS.MANDATORY_NEWLINE || item === WS.NEWLINE) throw new InlineLayoutError();
		else if (item === WS.INDENT || item === WS.SINGLE_INDENT || item === WS.SPACE) {
			if (!this.trailingSpace) {
				this.length++;
				this.trailingSpace = true;
			}
		} else if (item === WS.NO_NEWLINE || item === WS.NO_SPACE) {
			if (this.trailingSpace) {
				this.trailingSpace = false;
				this.length--;
			}
		}
	}
};
/**
* Thrown when block of SQL can't be formatted as a single line.
*/
var InlineLayoutError = class extends Error {};
// ../../node_modules/.bun/sql-formatter@15.9.0/node_modules/sql-formatter/dist/esm/formatter/ExpressionFormatter.js
/** Formats a generic SQL expression */
var ExpressionFormatter = class ExpressionFormatter {
	constructor({ cfg, dialectCfg, params, layout, inline = false, enclosingParenthesis }) {
		this.inline = false;
		this.nodes = [];
		this.index = -1;
		this.cfg = cfg;
		this.dialectCfg = dialectCfg;
		this.inline = inline;
		this.params = params;
		this.layout = layout;
		this.enclosingParenthesis = enclosingParenthesis;
	}
	format(nodes) {
		this.nodes = nodes;
		for (this.index = 0; this.index < this.nodes.length; this.index++) this.formatNode(this.nodes[this.index]);
		return this.layout;
	}
	formatNode(node) {
		this.formatComments(node.leadingComments);
		this.formatNodeWithoutComments(node);
		this.formatComments(node.trailingComments);
	}
	formatNodeWithoutComments(node) {
		switch (node.type) {
			case NodeType.function_call: return this.formatFunctionCall(node);
			case NodeType.parameterized_data_type: return this.formatParameterizedDataType(node);
			case NodeType.array_subscript: return this.formatArraySubscript(node);
			case NodeType.property_access: return this.formatPropertyAccess(node);
			case NodeType.parenthesis: return this.formatParenthesis(node);
			case NodeType.between_predicate: return this.formatBetweenPredicate(node);
			case NodeType.case_expression: return this.formatCaseExpression(node);
			case NodeType.case_when: return this.formatCaseWhen(node);
			case NodeType.case_else: return this.formatCaseElse(node);
			case NodeType.clause: return this.formatClause(node);
			case NodeType.set_operation: return this.formatSetOperation(node);
			case NodeType.limit_clause: return this.formatLimitClause(node);
			case NodeType.all_columns_asterisk: return this.formatAllColumnsAsterisk(node);
			case NodeType.literal: return this.formatLiteral(node);
			case NodeType.identifier: return this.formatIdentifier(node);
			case NodeType.parameter: return this.formatParameter(node);
			case NodeType.operator: return this.formatOperator(node);
			case NodeType.comma: return this.formatComma(node);
			case NodeType.line_comment: return this.formatLineComment(node);
			case NodeType.block_comment: return this.formatBlockComment(node);
			case NodeType.disable_comment: return this.formatBlockComment(node);
			case NodeType.data_type: return this.formatDataType(node);
			case NodeType.keyword: return this.formatKeywordNode(node);
		}
	}
	formatFunctionCall(node) {
		this.withComments(node.nameKw, () => {
			this.layout.add(this.showFunctionKw(node.nameKw));
		});
		this.formatNode(node.parenthesis);
	}
	formatParameterizedDataType(node) {
		this.withComments(node.dataType, () => {
			this.layout.add(this.showDataType(node.dataType));
		});
		this.formatNode(node.parenthesis);
	}
	formatArraySubscript(node) {
		let formattedArray;
		switch (node.array.type) {
			case NodeType.data_type:
				formattedArray = this.showDataType(node.array);
				break;
			case NodeType.keyword:
				formattedArray = this.showKw(node.array);
				break;
			default: formattedArray = this.showIdentifier(node.array);
		}
		this.withComments(node.array, () => {
			this.layout.add(formattedArray);
		});
		this.formatNode(node.parenthesis);
	}
	formatPropertyAccess(node) {
		this.formatNode(node.object);
		this.layout.add(WS.NO_SPACE, node.operator);
		this.formatNode(node.property);
	}
	formatParenthesis(node) {
		const inlineLayout = this.formatInlineExpression(node.children, node.openParen);
		if (inlineLayout) {
			this.layout.add(node.openParen);
			this.layout.add(...inlineLayout.getLayoutItems());
			this.layout.add(WS.NO_SPACE, node.closeParen, WS.SPACE);
		} else {
			this.layout.add(node.openParen, WS.NEWLINE);
			if (isTabularStyle(this.cfg)) {
				this.layout.add(WS.INDENT);
				this.layout = this.formatSubExpression(node.children, node.openParen);
			} else {
				this.layout.indentation.increaseBlockLevel();
				this.layout.add(WS.INDENT);
				this.layout = this.formatSubExpression(node.children, node.openParen);
				this.layout.indentation.decreaseBlockLevel();
			}
			this.layout.add(WS.NEWLINE, WS.INDENT, node.closeParen, WS.SPACE);
		}
	}
	formatBetweenPredicate(node) {
		this.layout.add(this.showKw(node.betweenKw), WS.SPACE);
		this.layout = this.formatSubExpression(node.expr1);
		this.layout.add(WS.NO_SPACE, WS.SPACE, this.showNonTabularKw(node.andKw), WS.SPACE);
		this.layout = this.formatSubExpression(node.expr2);
		this.layout.add(WS.NO_SPACE, WS.SPACE);
	}
	formatCaseExpression(node) {
		this.formatNode(node.caseKw);
		this.layout.indentation.increaseBlockLevel();
		this.layout = this.formatSubExpression(node.expr);
		this.layout = this.formatSubExpression(node.clauses);
		this.layout.indentation.decreaseBlockLevel();
		this.layout.add(WS.NEWLINE, WS.INDENT);
		this.formatNode(node.endKw);
	}
	formatCaseWhen(node) {
		this.layout.add(WS.NEWLINE, WS.INDENT);
		this.formatNode(node.whenKw);
		this.layout = this.formatSubExpression(node.condition);
		this.formatNode(node.thenKw);
		this.layout = this.formatSubExpression(node.result);
	}
	formatCaseElse(node) {
		this.layout.add(WS.NEWLINE, WS.INDENT);
		this.formatNode(node.elseKw);
		this.layout = this.formatSubExpression(node.result);
	}
	formatClause(node) {
		if (this.isOnelineClause(node)) this.formatClauseInOnelineStyle(node);
		else if (isTabularStyle(this.cfg)) this.formatClauseInTabularStyle(node);
		else this.formatClauseInIndentedStyle(node);
	}
	isOnelineClause(node) {
		if (isTabularStyle(this.cfg)) return this.dialectCfg.tabularOnelineClauses[node.nameKw.text];
		else return this.dialectCfg.onelineClauses[node.nameKw.text];
	}
	formatClauseInIndentedStyle(node) {
		this.layout.add(WS.NEWLINE, WS.INDENT, this.showKw(node.nameKw), WS.NEWLINE);
		this.layout.indentation.increaseTopLevel();
		this.layout.add(WS.INDENT);
		this.layout = this.formatSubExpression(node.children);
		this.layout.indentation.decreaseTopLevel();
	}
	formatClauseInOnelineStyle(node) {
		this.layout.add(WS.NEWLINE, WS.INDENT, this.showKw(node.nameKw), WS.SPACE);
		this.layout = this.formatSubExpression(node.children);
	}
	formatClauseInTabularStyle(node) {
		this.layout.add(WS.NEWLINE, WS.INDENT, this.showKw(node.nameKw), WS.SPACE);
		this.layout.indentation.increaseTopLevel();
		this.layout = this.formatSubExpression(node.children);
		this.layout.indentation.decreaseTopLevel();
	}
	formatSetOperation(node) {
		this.layout.add(WS.NEWLINE, WS.INDENT, this.showKw(node.nameKw), WS.NEWLINE);
		this.layout.add(WS.INDENT);
		this.layout = this.formatSubExpression(node.children);
	}
	formatLimitClause(node) {
		this.withComments(node.limitKw, () => {
			this.layout.add(WS.NEWLINE, WS.INDENT, this.showKw(node.limitKw));
		});
		this.layout.indentation.increaseTopLevel();
		if (isTabularStyle(this.cfg)) this.layout.add(WS.SPACE);
		else this.layout.add(WS.NEWLINE, WS.INDENT);
		if (node.offset) {
			this.layout = this.formatSubExpression(node.offset);
			this.layout.add(WS.NO_SPACE, ",", WS.SPACE);
			this.layout = this.formatSubExpression(node.count);
		} else this.layout = this.formatSubExpression(node.count);
		this.layout.indentation.decreaseTopLevel();
	}
	formatAllColumnsAsterisk(_node) {
		this.layout.add("*", WS.SPACE);
	}
	formatLiteral(node) {
		this.layout.add(node.text, WS.SPACE);
	}
	formatIdentifier(node) {
		this.layout.add(this.showIdentifier(node), WS.SPACE);
	}
	formatParameter(node) {
		this.layout.add(this.params.get(node), WS.SPACE);
	}
	formatOperator({ text }) {
		if (text === "-" && this.dialectCfg.identifierDashes) this.layout.add(text, WS.SPACE);
		else if (/^OPERATOR\s*\(/iu.test(text)) this.layout.add(text, WS.SPACE);
		else if (this.cfg.denseOperators || this.dialectCfg.alwaysDenseOperators.includes(text)) this.layout.add(WS.NO_SPACE, text);
		else if (text === ":" && this.enclosingParenthesis === "[") this.layout.add(WS.NO_SPACE, text);
		else if (text === ":") this.layout.add(WS.NO_SPACE, text, WS.SPACE);
		else this.layout.add(text, WS.SPACE);
	}
	formatComma(_node) {
		if (!this.inline) this.layout.add(WS.NO_SPACE, ",", WS.NEWLINE, WS.INDENT);
		else this.layout.add(WS.NO_SPACE, ",", WS.SPACE);
	}
	withComments(node, fn) {
		this.formatComments(node.leadingComments);
		fn();
		this.formatComments(node.trailingComments);
	}
	formatComments(comments) {
		if (!comments) return;
		comments.forEach((com) => {
			if (com.type === NodeType.line_comment) this.formatLineComment(com);
			else this.formatBlockComment(com);
		});
	}
	formatLineComment(node) {
		if (isMultiline(node.precedingWhitespace || "")) this.layout.add(WS.NEWLINE, WS.INDENT, node.text, WS.MANDATORY_NEWLINE, WS.INDENT);
		else if (this.layout.getLayoutItems().length > 0) this.layout.add(WS.NO_NEWLINE, WS.SPACE, node.text, WS.MANDATORY_NEWLINE, WS.INDENT);
		else this.layout.add(node.text, WS.MANDATORY_NEWLINE, WS.INDENT);
	}
	formatBlockComment(node) {
		if (node.type === NodeType.block_comment && this.isStandaloneBlockComment(node)) {
			this.splitBlockComment(node.text).forEach((line) => {
				this.layout.add(WS.NEWLINE, WS.INDENT, line);
			});
			this.layout.add(WS.NEWLINE, WS.INDENT);
		} else this.layout.add(node.text, WS.SPACE);
	}
	isStandaloneBlockComment(node) {
		return isMultiline(node.text) || isMultiline(node.precedingWhitespace || "") || this.layout.isAtStartOfLine();
	}
	isDocComment(comment) {
		const lines = comment.split(/\n/);
		return /^\/\*\*?$/.test(lines[0]) && lines.slice(1, lines.length - 1).every((line) => /^\s*\*/.test(line)) && /^\s*\*\/$/.test(last(lines));
	}
	splitBlockComment(comment) {
		if (this.isDocComment(comment)) return comment.split(/\n/).map((line) => {
			if (/^\s*\*/.test(line)) return " " + line.replace(/^\s*/, "");
			else return line;
		});
		else return comment.split(/\n/).map((line) => line.replace(/^\s*/, ""));
	}
	formatSubExpression(nodes, enclosingParenthesis = this.enclosingParenthesis) {
		return new ExpressionFormatter({
			cfg: this.cfg,
			dialectCfg: this.dialectCfg,
			params: this.params,
			layout: this.layout,
			inline: this.inline,
			enclosingParenthesis
		}).format(nodes);
	}
	formatInlineExpression(nodes, enclosingParenthesis = this.enclosingParenthesis) {
		const oldParamIndex = this.params.getPositionalParameterIndex();
		try {
			return new ExpressionFormatter({
				cfg: this.cfg,
				dialectCfg: this.dialectCfg,
				params: this.params,
				layout: new InlineLayout(this.cfg.expressionWidth),
				inline: true,
				enclosingParenthesis
			}).format(nodes);
		} catch (e) {
			if (e instanceof InlineLayoutError) {
				this.params.setPositionalParameterIndex(oldParamIndex);
				return;
			} else throw e;
		}
	}
	formatKeywordNode(node) {
		switch (node.tokenType) {
			case TokenType.RESERVED_JOIN: return this.formatJoin(node);
			case TokenType.AND:
			case TokenType.OR:
			case TokenType.XOR: return this.formatLogicalOperator(node);
			default: return this.formatKeyword(node);
		}
	}
	formatJoin(node) {
		if (isTabularStyle(this.cfg)) {
			this.layout.indentation.decreaseTopLevel();
			this.layout.add(WS.NEWLINE, WS.INDENT, this.showKw(node), WS.SPACE);
			this.layout.indentation.increaseTopLevel();
		} else this.layout.add(WS.NEWLINE, WS.INDENT, this.showKw(node), WS.SPACE);
	}
	formatKeyword(node) {
		this.layout.add(this.showKw(node), WS.SPACE);
	}
	formatLogicalOperator(node) {
		if (this.cfg.logicalOperatorNewline === "before") {
			if (isTabularStyle(this.cfg)) {
				this.layout.indentation.decreaseTopLevel();
				this.layout.add(WS.NEWLINE, WS.INDENT, this.showKw(node), WS.SPACE);
				this.layout.indentation.increaseTopLevel();
			} else this.layout.add(WS.NEWLINE, WS.INDENT, this.showKw(node), WS.SPACE);
		} else this.layout.add(this.showKw(node), WS.NEWLINE, WS.INDENT);
	}
	formatDataType(node) {
		this.layout.add(this.showDataType(node), WS.SPACE);
	}
	showKw(node) {
		if (isTabularToken(node.tokenType)) return toTabularFormat(this.showNonTabularKw(node), this.cfg.indentStyle);
		else return this.showNonTabularKw(node);
	}
	showNonTabularKw(node) {
		switch (this.cfg.keywordCase) {
			case "preserve": return equalizeWhitespace(node.raw);
			case "upper": return node.text;
			case "lower": return node.text.toLowerCase();
		}
	}
	showFunctionKw(node) {
		if (isTabularToken(node.tokenType)) return toTabularFormat(this.showNonTabularFunctionKw(node), this.cfg.indentStyle);
		else return this.showNonTabularFunctionKw(node);
	}
	showNonTabularFunctionKw(node) {
		switch (this.cfg.functionCase) {
			case "preserve": return equalizeWhitespace(node.raw);
			case "upper": return node.text;
			case "lower": return node.text.toLowerCase();
		}
	}
	showIdentifier(node) {
		if (node.quoted) return node.text;
		else switch (this.cfg.identifierCase) {
			case "preserve": return node.text;
			case "upper": return node.text.toUpperCase();
			case "lower": return node.text.toLowerCase();
		}
	}
	showDataType(node) {
		switch (this.cfg.dataTypeCase) {
			case "preserve": return equalizeWhitespace(node.raw);
			case "upper": return node.text;
			case "lower": return node.text.toLowerCase();
		}
	}
};
// ../../node_modules/.bun/sql-formatter@15.9.0/node_modules/sql-formatter/dist/esm/formatter/Formatter.js
/** Main formatter class that produces a final output string from list of tokens */
var Formatter = class {
	constructor(dialect, cfg) {
		this.dialect = dialect;
		this.cfg = cfg;
		this.params = new Params(this.cfg.params);
	}
	/**
	* Formats an SQL query.
	* @param {string} query - The SQL query string to be formatted
	* @return {string} The formatter query
	*/
	format(query) {
		const ast = this.parse(query);
		return this.formatAst(ast).trimEnd();
	}
	parse(query) {
		return createParser(this.dialect.tokenizer).parse(query, this.cfg.paramTypes || {});
	}
	formatAst(statements) {
		return statements.map((stat) => this.formatStatement(stat)).join("\n".repeat(this.cfg.linesBetweenQueries + 1));
	}
	formatStatement(statement) {
		const layout = new ExpressionFormatter({
			cfg: this.cfg,
			dialectCfg: this.dialect.formatOptions,
			params: this.params,
			layout: new Layout(new Indentation(indentString(this.cfg)))
		}).format(statement.children);
		if (!statement.hasSemicolon) {} else if (this.cfg.newlineBeforeSemicolon) layout.add(WS.NEWLINE, ";");
		else layout.add(WS.NO_NEWLINE, ";");
		return layout.toString();
	}
};
// ../../node_modules/.bun/sql-formatter@15.9.0/node_modules/sql-formatter/dist/esm/validateConfig.js
var ConfigError = class extends Error {};
function validateConfig(cfg) {
	for (const optionName of [
		"multilineLists",
		"newlineBeforeOpenParen",
		"newlineBeforeCloseParen",
		"aliasAs",
		"commaPosition",
		"tabulateAlias"
	]) if (optionName in cfg) throw new ConfigError(`${optionName} config is no more supported.`);
	if (cfg.expressionWidth <= 0) throw new ConfigError(`expressionWidth config must be positive number. Received ${cfg.expressionWidth} instead.`);
	if (cfg.params && !validateParams(cfg.params)) console.warn("WARNING: All \"params\" option values should be strings.");
	if (cfg.paramTypes && !validateParamTypes(cfg.paramTypes)) throw new ConfigError("Empty regex given in custom paramTypes. That would result in matching infinite amount of parameters.");
	return cfg;
}
function validateParams(params) {
	return (params instanceof Array ? params : Object.values(params)).every((p) => typeof p === "string");
}
function validateParamTypes(paramTypes) {
	if (paramTypes.custom && Array.isArray(paramTypes.custom)) return paramTypes.custom.every((p) => p.regex !== "");
	return true;
}
// ../../node_modules/.bun/sql-formatter@15.9.0/node_modules/sql-formatter/dist/esm/sqlFormatter.js
var __rest = function(s, e) {
	var t = {};
	for (var p in s) if (Object.prototype.hasOwnProperty.call(s, p) && e.indexOf(p) < 0) t[p] = s[p];
	if (s != null && typeof Object.getOwnPropertySymbols === "function") {
		for (var i = 0, p = Object.getOwnPropertySymbols(s); i < p.length; i++) if (e.indexOf(p[i]) < 0 && Object.prototype.propertyIsEnumerable.call(s, p[i])) t[p[i]] = s[p[i]];
	}
	return t;
};
var defaultOptions = {
	tabWidth: 2,
	useTabs: false,
	keywordCase: "preserve",
	identifierCase: "preserve",
	dataTypeCase: "preserve",
	functionCase: "preserve",
	indentStyle: "standard",
	logicalOperatorNewline: "before",
	expressionWidth: 50,
	linesBetweenQueries: 1,
	denseOperators: false,
	newlineBeforeSemicolon: false
};
/**
* Like the above format(), but language parameter is mandatory
* and must be a Dialect object instead of a string.
*
* @param {string} query - input SQL query string
* @param {FormatOptionsWithDialect} cfg Configuration options (see docs in README)
* @return {string} formatted query
*/
var formatDialect = (query, _a) => {
	var { dialect } = _a, cfg = __rest(_a, ["dialect"]);
	if (typeof query !== "string") throw new Error("Invalid query argument. Expected string, instead got " + typeof query);
	const options = validateConfig(Object.assign(Object.assign({}, defaultOptions), cfg));
	return new Formatter(createDialect(dialect), options).format(query);
};
// ../plugin-api/src/sql/layoutNodes.ts
/** Raised for SQL the aligned layout does not read; the statement then goes to `sql-formatter` (decision 062). */
var Unsupported = class extends Error {};
var OPERATOR_CHARS = /* @__PURE__ */ new Set("+-*/<>=~!@#%^&|`?:");
var OPEN = "(";
var CLOSE = ")";
var COMMA$2 = ",";
var DOT = ".";
var CAST$1 = "::";
var CASE$1 = "CASE";
var END$1 = "END";
var LINE_BREAK$2 = "\n";
/** Reserved in PostgreSQL or MySQL, so never a bare column or table name worth keeping in its case. */
var RESERVED = /* @__PURE__ */ new Set([
	"ALL",
	"AND",
	"ANY",
	"AS",
	"ASC",
	"BETWEEN",
	"BY",
	"CASE",
	"CROSS",
	"DEFAULT",
	"DELETE",
	"DESC",
	"DISTINCT",
	"DISTINCTROW",
	"DIV",
	"ELSE",
	"END",
	"ESCAPE",
	"EXCEPT",
	"EXISTS",
	"FALSE",
	"FETCH",
	"FOR",
	"FROM",
	"FULL",
	"GROUP",
	"HAVING",
	"HIGH_PRIORITY",
	"IGNORE",
	"ILIKE",
	"IN",
	"INNER",
	"INSERT",
	"INTERSECT",
	"INTERVAL",
	"INTO",
	"IS",
	"ISNULL",
	"JOIN",
	"LATERAL",
	"LEFT",
	"LIKE",
	"LIMIT",
	"LOW_PRIORITY",
	"NATURAL",
	"NOT",
	"NOTNULL",
	"NULL",
	"OFFSET",
	"ON",
	"OR",
	"ORDER",
	"OUTER",
	"OVER",
	"PARTITION",
	"RECURSIVE",
	"REGEXP",
	"RETURNING",
	"RIGHT",
	"RLIKE",
	"SELECT",
	"SET",
	"SIMILAR",
	"SOME",
	"SQL_BIG_RESULT",
	"SQL_BUFFER_RESULT",
	"SQL_CACHE",
	"SQL_CALC_FOUND_ROWS",
	"SQL_NO_CACHE",
	"SQL_SMALL_RESULT",
	"STRAIGHT_JOIN",
	"TABLESAMPLE",
	"THEN",
	"TRUE",
	"UNION",
	"UPDATE",
	"USING",
	"VALUES",
	"WHEN",
	"WHERE",
	"WINDOW",
	"WITH",
	"XOR"
]);
/** Keywords that are also functions; glued to a `(` as written they are the function, cased as written. */
var FUNCTION_KEYWORDS = /* @__PURE__ */ new Set([
	"DEFAULT",
	"INSERT",
	"INTERVAL",
	"LEFT",
	"RIGHT",
	"VALUES"
]);
/** Pairs where the second word is a keyword only after the first (`USE INDEX`, `NULLS LAST`). */
var CONTEXTUAL_PAIRS = [
	[/* @__PURE__ */ new Set([
		"USE",
		"FORCE",
		"IGNORE"
	]), /* @__PURE__ */ new Set(["INDEX", "KEY"])],
	[/* @__PURE__ */ new Set(["ON"]), /* @__PURE__ */ new Set([
		"DUPLICATE",
		"CONFLICT",
		"CONSTRAINT"
	])],
	[/* @__PURE__ */ new Set(["DUPLICATE"]), /* @__PURE__ */ new Set(["KEY"])],
	[/* @__PURE__ */ new Set(["DO"]), /* @__PURE__ */ new Set(["NOTHING", "UPDATE"])],
	[/* @__PURE__ */ new Set(["NULLS"]), /* @__PURE__ */ new Set(["FIRST", "LAST"])],
	[/* @__PURE__ */ new Set(["LOCK"]), /* @__PURE__ */ new Set(["IN"])],
	[/* @__PURE__ */ new Set(["SHARE"]), /* @__PURE__ */ new Set(["MODE"])],
	[/* @__PURE__ */ new Set(["FOR"]), /* @__PURE__ */ new Set([
		"SHARE",
		"NO",
		"KEY"
	])],
	[/* @__PURE__ */ new Set(["NO"]), /* @__PURE__ */ new Set(["KEY"])],
	[/* @__PURE__ */ new Set(["KEY"]), /* @__PURE__ */ new Set(["SHARE", "UPDATE"])],
	[/* @__PURE__ */ new Set(["SKIP"]), /* @__PURE__ */ new Set(["LOCKED"])],
	[/* @__PURE__ */ new Set(["FETCH"]), /* @__PURE__ */ new Set(["FIRST", "NEXT"])],
	[/* @__PURE__ */ new Set(["ROW", "ROWS"]), /* @__PURE__ */ new Set(["ONLY"])],
	[/* @__PURE__ */ new Set(["WITH"]), /* @__PURE__ */ new Set(["TIES"])],
	[/* @__PURE__ */ new Set([
		"FROM",
		"JOIN",
		"UPDATE"
	]), /* @__PURE__ */ new Set(["ONLY"])],
	[/* @__PURE__ */ new Set(["AS", "NOT"]), /* @__PURE__ */ new Set(["MATERIALIZED"])],
	[/* @__PURE__ */ new Set(["UPDATE", "SHARE"]), /* @__PURE__ */ new Set(["NOWAIT"])]
];
/** The first word of a pair that is a keyword itself once its second word follows. */
var CONTEXTUAL_LEADS = /* @__PURE__ */ new Set([
	"USE",
	"FORCE",
	"DUPLICATE",
	"DO",
	"NULLS",
	"LOCK",
	"SHARE",
	"NO",
	"KEY",
	"SKIP"
]);
/** Inside `OVER ( … )`: the frame clause. */
var WINDOW_WORDS = /* @__PURE__ */ new Set([
	"ROWS",
	"RANGE",
	"GROUPS",
	"UNBOUNDED",
	"PRECEDING",
	"FOLLOWING",
	"CURRENT",
	"ROW",
	"EXCLUDE",
	"TIES",
	"OTHERS",
	"NO"
]);
/** Operator characters next to each other are one operator, so the layout never puts a space inside `>=` or `->>`. */
function mergeOperators(text, tokens) {
	const merged = [];
	for (const token of tokens) {
		const last = merged.at(-1);
		if (last !== void 0 && token.kind === "symbol" && last.kind === "symbol" && last.to === token.from && OPERATOR_CHARS.has(text.charAt(token.from)) && OPERATOR_CHARS.has(text.charAt(last.from))) merged[merged.length - 1] = {
			kind: "symbol",
			from: last.from,
			to: token.to
		};
		else merged.push(token);
	}
	return merged;
}
function isLineComment(comment) {
	return !comment.startsWith("/*");
}
function flatten(text, dialect) {
	const lexer = new Lexer(text, dialect);
	const significant = [];
	const comments = [];
	for (let token = lexer.next(); token !== null; token = lexer.next()) {
		if (token.kind === "delimiter") throw new Unsupported("a statement holding a delimiter");
		(token.kind === "comment" ? comments : significant).push(token);
	}
	const tokens = mergeOperators(text, significant);
	const flat = tokens.map((token, index) => {
		const before = tokens[index - 1];
		return {
			token,
			text: text.slice(token.from, token.to),
			spaced: before === void 0 || before.to < token.from,
			leading: [],
			trailing: []
		};
	});
	const tail = [];
	let next = 0;
	for (const comment of comments) {
		while (next < flat.length && (flat[next]?.token.from ?? 0) < comment.from) next += 1;
		const content = text.slice(comment.from, comment.to);
		const previous = flat[next - 1];
		if (previous !== void 0 && !text.slice(previous.token.to, comment.from).includes(LINE_BREAK$2)) previous.trailing.push(content);
		else if (next < flat.length) flat[next]?.leading.push(content);
		else tail.push(content);
	}
	moveCommentsPastCommas(flat);
	return {
		flat,
		tail
	};
}
/** `a -- note` then `, b` reads as `a, -- note`; a comment on its own line before a comma goes after it. */
function moveCommentsPastCommas(flat) {
	flat.forEach((entry, index) => {
		if (entry.text !== COMMA$2) return;
		const previous = flat[index - 1];
		if (previous !== void 0 && previous.trailing.some(isLineComment)) entry.trailing.unshift(...previous.trailing.splice(0));
		const following = flat[index + 1];
		if (following !== void 0 && entry.leading.length > 0) following.leading.unshift(...entry.leading.splice(0));
	});
}
function keywordFlags(flat) {
	const uppers = flat.map((entry) => entry.token.kind === "word" ? entry.text.toUpperCase() : "");
	const flags = flat.map((entry, index) => {
		const upper = uppers[index] ?? "";
		if (!RESERVED.has(upper)) return false;
		const previous = flat[index - 1];
		if (previous?.text === CAST$1 || previous?.text === DOT && !entry.spaced) return false;
		const next = flat[index + 1];
		return !(FUNCTION_KEYWORDS.has(upper) && next?.text === OPEN && !next.spaced);
	});
	uppers.forEach((upper, index) => {
		const next = uppers[index + 1] ?? "";
		for (const [first, second] of CONTEXTUAL_PAIRS) {
			if (!first.has(upper) || !second.has(next)) continue;
			flags[index + 1] = true;
			if (CONTEXTUAL_LEADS.has(upper)) flags[index] = true;
		}
	});
	const overDepths = [];
	let depth = 0;
	flat.forEach((entry, index) => {
		if (entry.text === OPEN) {
			depth += 1;
			if (uppers[index - 1] === "OVER") overDepths.push(depth);
		} else if (entry.text === CLOSE) {
			if (overDepths.at(-1) === depth) overDepths.pop();
			depth -= 1;
		} else if (overDepths.at(-1) === depth && WINDOW_WORDS.has(uppers[index] ?? "")) flags[index] = true;
	});
	return flags;
}
/** The statement as tokens nested by parentheses and `CASE … END`; throws `Unsupported` when they do not balance. */
function parseStatement(text, dialect) {
	const { flat, tail } = flatten(text, dialect);
	const flags = keywordFlags(flat);
	const stack = [{
		opener: null,
		kind: "root",
		children: []
	}];
	const top = () => stack[stack.length - 1] ?? {
		opener: null,
		kind: "root",
		children: []
	};
	flat.forEach((entry, index) => {
		const tok = {
			type: "tok",
			kind: entry.token.kind === "comment" || entry.token.kind === "delimiter" ? "symbol" : entry.token.kind,
			text: entry.text,
			upper: entry.text.toUpperCase(),
			spaced: entry.spaced,
			keyword: flags[index] ?? false,
			leading: entry.leading,
			trailing: entry.trailing
		};
		if (tok.text === OPEN) stack.push({
			opener: tok,
			kind: "group",
			children: []
		});
		else if (tok.text === CLOSE) {
			const frame = stack.pop();
			if (frame?.kind !== "group" || frame.opener === null) throw new Unsupported("an unbalanced parenthesis");
			top().children.push({
				type: "group",
				open: frame.opener,
				children: frame.children,
				close: tok
			});
		} else if (tok.keyword && tok.upper === CASE$1) stack.push({
			opener: tok,
			kind: "case",
			children: []
		});
		else if (tok.keyword && tok.upper === END$1) {
			const frame = stack.pop();
			if (frame?.kind !== "case" || frame.opener === null) throw new Unsupported("an END without its CASE");
			top().children.push({
				type: "case",
				head: frame.opener,
				children: frame.children,
				end: tok
			});
		} else top().children.push(tok);
	});
	if (stack.length !== 1) throw new Unsupported("an unclosed parenthesis or CASE");
	return {
		nodes: top().children,
		tail
	};
}
function firstTok(node) {
	if (node.type === "tok") return node;
	return node.type === "group" ? node.open : node.head;
}
function lastTok(node) {
	if (node.type === "tok") return node;
	return node.type === "group" ? node.close : node.end;
}
/** `node` is the keyword `word`. */
function isWord(node, word) {
	return node?.type === "tok" && node.keyword && node.upper === word;
}
/** `node` is a word spelled `word`, keyword or not (a clause the layout reads structurally). */
function spells(node, word) {
	return node?.type === "tok" && node.kind === "word" && node.upper === word;
}
// ../plugin-api/src/sql/layoutWriter.ts
var LINE_BREAK$1 = "\n";
var SPACE$1 = " ";
/**
* Text built line by line with the column it has reached. A line comment forces the next token
* onto a new line at `indent`, the column the current layout continues at.
*/
var Writer = class {
	out = "";
	column;
	indent;
	#content = false;
	#pendingBreak = false;
	constructor(column) {
		this.column = column;
		this.indent = column;
	}
	/** The text ends in a line comment, so nothing may follow it on its line. */
	get endsInLineComment() {
		return this.#pendingBreak;
	}
	newline(column = this.indent) {
		this.#pendingBreak = false;
		const lineStart = this.out.lastIndexOf(LINE_BREAK$1) + 1;
		if (!this.#content) {
			if (lineStart === 0) return;
			this.out = this.out.slice(0, lineStart) + SPACE$1.repeat(column);
		} else this.out += LINE_BREAK$1 + SPACE$1.repeat(column);
		this.column = column;
		this.#content = false;
	}
	pad(width) {
		if (width <= 0) return;
		this.out += SPACE$1.repeat(width);
		this.column += width;
	}
	/** `text` (one token, or a comment that may span lines), a space before it when asked and the line has text. */
	write(text, spaceBefore) {
		if (this.#pendingBreak) this.newline();
		else if (spaceBefore && this.#content) this.#append(SPACE$1);
		this.#append(text);
	}
	tok(tok, text, spaceBefore) {
		for (const comment of tok.leading) {
			if (this.#content) this.newline();
			this.#append(comment);
			this.newline();
		}
		this.write(text, spaceBefore);
		for (const comment of tok.trailing) {
			this.#append(SPACE$1 + comment);
			if (isLineComment(comment)) this.#pendingBreak = true;
		}
	}
	/** A comment on a line of its own. */
	comment(comment, column) {
		this.newline(column);
		this.#append(comment);
		if (isLineComment(comment)) this.#pendingBreak = true;
	}
	#append(text) {
		this.out += text;
		const lineBreak = text.lastIndexOf(LINE_BREAK$1);
		this.column = lineBreak < 0 ? this.column + text.length : text.length - lineBreak - 1;
		this.#content = true;
	}
};
var COMMA$1 = ",";
var CAST = "::";
var EQUALS = "=";
/** Operators written with one space on each side; any other run of operator characters keeps its source spacing. */
var SPACED_OPERATORS = /* @__PURE__ */ new Set([
	"=",
	"<",
	">",
	"<=",
	">=",
	"<>",
	"!=",
	"<=>",
	":="
]);
var SET_OPERATORS = /* @__PURE__ */ new Set([
	"UNION",
	"INTERSECT",
	"EXCEPT",
	"MINUS"
]);
var SET_QUANTIFIERS = /* @__PURE__ */ new Set(["ALL", "DISTINCT"]);
var SELECT_MODIFIERS = /* @__PURE__ */ new Set([
	"ALL",
	"DISTINCT",
	"DISTINCTROW",
	"HIGH_PRIORITY",
	"STRAIGHT_JOIN",
	"SQL_SMALL_RESULT",
	"SQL_BIG_RESULT",
	"SQL_BUFFER_RESULT",
	"SQL_NO_CACHE",
	"SQL_CACHE",
	"SQL_CALC_FOUND_ROWS"
]);
var JOIN_WORDS = /* @__PURE__ */ new Set(["JOIN", "STRAIGHT_JOIN"]);
var JOIN_MODIFIERS = /* @__PURE__ */ new Set([
	"NATURAL",
	"INNER",
	"LEFT",
	"RIGHT",
	"FULL",
	"OUTER",
	"CROSS"
]);
var CONDITION_OPERATORS = /* @__PURE__ */ new Set(["AND", "OR"]);
var QUERY_VERBS = /* @__PURE__ */ new Set([
	"SELECT",
	"WITH",
	"INSERT",
	"REPLACE",
	"UPDATE",
	"DELETE"
]);
var EXPLAIN_WORDS = /* @__PURE__ */ new Set([
	"EXPLAIN",
	"DESCRIBE",
	"DESC",
	"ANALYZE",
	"ANALYSE",
	"VERBOSE",
	"FORMAT",
	"EXTENDED",
	"PARTITIONS",
	"QUERY",
	"PLAN"
]);
var INDEX_WORDS = /* @__PURE__ */ new Set(["INDEX", "KEY"]);
var DELETE_MODIFIERS = /* @__PURE__ */ new Set([
	"LOW_PRIORITY",
	"QUICK",
	"IGNORE"
]);
function wordAt(nodes, index) {
	const node = nodes[index];
	return node?.type === "tok" && node.kind === "word" ? node.upper : "";
}
function keywordAt(nodes, index) {
	const node = nodes[index];
	return node?.type === "tok" && node.keyword ? node.upper : "";
}
function selectClauses(nodes, index, current) {
	switch (keywordAt(nodes, index)) {
		case "SELECT":
		case "INTO":
		case "FROM":
		case "WHERE":
		case "HAVING":
		case "WINDOW":
		case "LIMIT":
		case "FETCH": return 1;
		case "GROUP":
		case "ORDER": return wordAt(nodes, index + 1) === "BY" ? 2 : 0;
		case "OFFSET": return current === "LIMIT" ? 0 : 1;
		case "FOR": return INDEX_WORDS.has(wordAt(nodes, index - 1)) || current === "FOR" ? 0 : 1;
		case "LOCK": return wordAt(nodes, index + 1) === "IN" ? 1 : 0;
		default: return 0;
	}
}
function updateClauses(nodes, index) {
	const word = keywordAt(nodes, index);
	if (word === "UPDATE" || word === "SET" || word === "FROM" || word === "WHERE" || word === "LIMIT") return 1;
	if (word === "RETURNING") return 1;
	return word === "ORDER" && wordAt(nodes, index + 1) === "BY" ? 2 : 0;
}
function deleteClauses(nodes, index) {
	const word = keywordAt(nodes, index);
	if (word === "DELETE" || word === "FROM" || word === "USING" || word === "WHERE" || word === "LIMIT") return 1;
	if (word === "RETURNING") return 1;
	return word === "ORDER" && wordAt(nodes, index + 1) === "BY" ? 2 : 0;
}
function splitClauses(nodes, matcher) {
	const head = [];
	const clauses = [];
	for (let index = 0; index < nodes.length;) {
		const count = matcher(nodes, index, clauses.at(-1)?.name ?? "");
		if (count > 0) {
			const keywords = nodes.slice(index, index + count);
			for (const keyword of keywords) keyword.keyword = true;
			clauses.push({
				name: keywords.map((keyword) => keyword.upper).join(" "),
				keywords,
				body: []
			});
			index += count;
			continue;
		}
		const node = nodes[index];
		if (node !== void 0) (clauses.at(-1)?.body ?? head).push(node);
		index += 1;
	}
	return {
		head,
		clauses
	};
}
function splitTop(nodes, separator) {
	const parts = [[]];
	const commas = [];
	for (const node of nodes) if (node.type === "tok" && node.text === separator) {
		commas.push(node);
		parts.push([]);
	} else parts[parts.length - 1]?.push(node);
	return {
		parts,
		commas
	};
}
/** Top-level `AND` / `OR`, but not the `AND` of `BETWEEN a AND b`. */
function splitConditions(nodes) {
	const conditions = [{
		operator: null,
		nodes: []
	}];
	let between = false;
	for (const node of nodes) {
		if (isWord(node, "BETWEEN")) between = true;
		if (node.type === "tok" && node.keyword && CONDITION_OPERATORS.has(node.upper)) {
			if (between && node.upper === "AND") between = false;
			else {
				conditions.push({
					operator: node,
					nodes: []
				});
				continue;
			}
		}
		conditions[conditions.length - 1]?.nodes.push(node);
	}
	return conditions;
}
function isQueryStart(nodes) {
	const first = nodes[0];
	if (first === void 0) return false;
	if (first.type === "group") return isQueryStart(first.children);
	return first.type === "tok" && (isWord(first, "SELECT") || isWord(first, "WITH"));
}
function isSubquery(group) {
	return isQueryStart(group.children);
}
function isSpacedOperator(tok) {
	return tok.kind === "symbol" && SPACED_OPERATORS.has(tok.text);
}
function casedKeyword(text, options) {
	if (options.keywordCase === "upper") return text.toUpperCase();
	if (options.keywordCase === "lower") return text.toLowerCase();
	return text;
}
/** The aligned layout of one statement (decision 061). Throws `Unsupported` for what it does not read. */
var AlignedPrinter = class {
	options;
	constructor(options) {
		this.options = options;
	}
	text(tok) {
		return tok.keyword ? casedKeyword(tok.text, this.options) : tok.text;
	}
	print(nodes, tail) {
		const writer = new Writer(0);
		const prefixEnd = this.#explainPrefixEnd(nodes);
		if (prefixEnd > 0) {
			this.inline(writer, nodes.slice(0, prefixEnd), false, { preserve: true });
			writer.newline(0);
		}
		this.statement(writer, nodes.slice(prefixEnd), 0);
		for (const comment of tail) writer.comment(comment, 0);
		return {
			text: writer.out,
			endsInLineComment: writer.endsInLineComment
		};
	}
	#explainPrefixEnd(nodes) {
		if (!EXPLAIN_VERBS$1.has(wordAt(nodes, 0))) return 0;
		const start = nodes.findIndex((node) => node.type === "tok" && node.kind === "word" && QUERY_VERBS.has(node.upper) || node.type === "group" && isSubquery(node));
		if (start <= 0) throw new Unsupported("an EXPLAIN of no query");
		for (const node of nodes.slice(0, start)) this.#markExplainWords(node);
		return start;
	}
	#markExplainWords(node) {
		if (node.type === "tok") {
			if (node.kind === "word" && EXPLAIN_WORDS.has(node.upper)) node.keyword = true;
		} else if (node.type === "group") for (const child of node.children) this.#markExplainWords(child);
	}
	statement(writer, nodes, base) {
		const first = nodes[0];
		if (first === void 0) throw new Unsupported("an empty statement");
		if (first.type === "group") {
			this.setQuery(writer, nodes, base);
			return;
		}
		switch (first.type === "tok" && first.kind === "word" ? first.upper : "") {
			case "WITH":
				this.withQuery(writer, nodes, base);
				return;
			case "SELECT":
				this.setQuery(writer, nodes, base);
				return;
			case "INSERT":
			case "REPLACE":
				this.insert(writer, nodes, base);
				return;
			case "UPDATE":
				this.update(writer, nodes, base);
				return;
			case "DELETE":
				this.delete(writer, nodes, base);
				return;
			default: throw new Unsupported("a statement the aligned layout does not read");
		}
	}
	withQuery(writer, nodes, base) {
		let index = 0;
		const keywords = [];
		while (index < nodes.length && (isWord(nodes[index], "WITH") || isWord(nodes[index], "RECURSIVE"))) {
			keywords.push(nodes[index]);
			index += 1;
		}
		keywords.forEach((keyword, at) => {
			writer.tok(keyword, this.text(keyword), at > 0);
		});
		const column = writer.column + 1;
		const saved = writer.indent;
		writer.indent = column;
		let first = true;
		for (;;) {
			const bodyAt = nodes.findIndex((node, at) => at > index && node.type === "group" && (isWord(nodes[at - 1], "AS") || isWord(nodes[at - 1], "MATERIALIZED")));
			const body = nodes[bodyAt];
			if (body?.type !== "group") throw new Unsupported("a WITH without its query");
			const asAt = nodes.slice(index, bodyAt).findIndex((node) => isWord(node, "AS")) + index;
			if (asAt < index) throw new Unsupported("a common table expression without AS");
			this.inline(writer, nodes.slice(index, asAt), first, { spaceBeforeGroup: true });
			this.inline(writer, nodes.slice(asAt, bodyAt), true);
			writer.tok(body.open, this.text(body.open), true);
			this.#nested(writer, body.children);
			writer.tok(body.close, this.text(body.close), false);
			first = false;
			index = bodyAt + 1;
			const next = nodes[index];
			if (next?.type === "tok" && next.text === COMMA$1) {
				writer.tok(next, next.text, false);
				writer.newline(column);
				index += 1;
				continue;
			}
			break;
		}
		writer.indent = saved;
		if (index >= nodes.length) throw new Unsupported("a WITH without its main statement");
		writer.newline(base);
		this.statement(writer, nodes.slice(index), base);
	}
	/** A statement inside parentheses, laid out at the column after `(`. */
	#nested(writer, nodes) {
		const saved = writer.indent;
		const column = writer.column;
		writer.indent = column;
		this.statement(writer, nodes, column);
		writer.indent = saved;
	}
	setQuery(writer, nodes, base) {
		const parts = [[]];
		const operators = [];
		for (let index = 0; index < nodes.length; index += 1) {
			const node = nodes[index];
			if (node === void 0) continue;
			if (node.type === "tok" && node.keyword && SET_OPERATORS.has(node.upper)) {
				const operator = [node];
				const quantifier = nodes[index + 1];
				if (quantifier?.type === "tok" && quantifier.keyword && SET_QUANTIFIERS.has(quantifier.upper)) {
					operator.push(quantifier);
					index += 1;
				}
				operators.push(operator);
				parts.push([]);
				continue;
			}
			parts[parts.length - 1]?.push(node);
		}
		parts.forEach((part, at) => {
			const operator = operators[at - 1];
			if (operator !== void 0) {
				writer.newline(base);
				operator.forEach((tok, position) => {
					writer.tok(tok, this.text(tok), position > 0);
				});
				writer.newline(base);
			}
			this.select(writer, part, base);
		});
	}
	select(writer, nodes, base) {
		const first = nodes[0];
		if (first === void 0) throw new Unsupported("an empty query");
		let rest = nodes;
		let started = false;
		if (first.type === "group") {
			if (!isQueryStart(first.children)) throw new Unsupported("a parenthesised query of no SELECT");
			writer.tok(first.open, first.open.text, false);
			this.#nested(writer, first.children);
			writer.tok(first.close, first.close.text, false);
			rest = nodes.slice(1);
			started = true;
		} else if (!isWord(first, "SELECT")) throw new Unsupported("a query that does not start with SELECT");
		const { head, clauses } = splitClauses(rest, selectClauses);
		if (head.length > 0) throw new Unsupported("tokens before the first clause");
		clauses.forEach((clause, at) => {
			if (at > 0 || started) writer.newline(base);
			writer.indent = base;
			this.clause(writer, clause);
		});
	}
	clause(writer, clause) {
		switch (clause.name) {
			case "SELECT":
				this.selectClause(writer, clause);
				return;
			case "FROM":
			case "UPDATE":
				this.#keywords(writer, clause.keywords);
				this.fromItems(writer, clause.body, writer.column + 1);
				return;
			case "WHERE":
			case "HAVING":
				this.#keywords(writer, clause.keywords);
				this.conditions(writer, clause.body, writer.column - this.#width(clause.keywords), writer.column);
				return;
			case "SET":
				this.#keywords(writer, clause.keywords);
				this.assignments(writer, clause.body, writer.column + 1);
				return;
			default:
				this.#keywords(writer, clause.keywords);
				this.#inlineBody(writer, clause.body);
		}
	}
	#keywords(writer, keywords, leadSpace = false) {
		keywords.forEach((keyword, at) => {
			writer.tok(keyword, this.text(keyword), at > 0 || leadSpace);
		});
	}
	/** The width of `keywords` written on one line. */
	#width(keywords) {
		return keywords.map((keyword) => this.text(keyword)).join(" ").length;
	}
	#inlineBody(writer, body) {
		const saved = writer.indent;
		writer.indent = writer.column + 1;
		this.inline(writer, body, true);
		writer.indent = saved;
	}
	selectClause(writer, clause) {
		const keywords = [...clause.keywords];
		let index = 0;
		for (; index < clause.body.length; index += 1) {
			const node = clause.body[index];
			if (node?.type !== "tok" || !node.keyword || !SELECT_MODIFIERS.has(node.upper)) break;
			keywords.push(node);
			if (node.upper === "DISTINCT" && isWord(clause.body[index + 1], "ON")) {
				keywords.push(clause.body[index + 1]);
				index += 1;
			}
		}
		this.#keywords(writer, keywords);
		const distinctOn = clause.body[index];
		if (isWord(clause.body[index - 1], "ON") && distinctOn?.type === "group") {
			this.node(writer, distinctOn, true);
			index += 1;
		}
		this.selectList(writer, clause.body.slice(index), writer.column + 1);
	}
	/** One item per line under the first; aliases after `AS` line up (rule 5). */
	selectList(writer, nodes, column) {
		const { parts, commas } = splitTop(nodes, COMMA$1);
		const items = parts.map((part) => {
			const as = part[part.length - 2];
			const name = part[part.length - 1];
			const aliased = part.length >= 3 && isWord(as, "AS") && name?.type === "tok" && name.kind !== "symbol";
			const expression = aliased ? part.slice(0, -2) : part;
			const width = aliased ? this.#singleLineWidth(column, expression) : null;
			return {
				part,
				expression,
				alias: aliased ? part.slice(-2) : [],
				width
			};
		});
		const target = this.#alignment(items.map((item) => item.width));
		const saved = writer.indent;
		writer.indent = column;
		items.forEach((item, at) => {
			if (at > 0) writer.newline(column);
			this.inline(writer, item.expression, at === 0);
			if (item.alias.length > 0) {
				if (target !== null && item.width !== null) writer.pad(target - item.width);
				this.inline(writer, item.alias, true);
			}
			const comma = commas[at];
			if (comma !== void 0) writer.tok(comma, comma.text, false);
		});
		writer.indent = saved;
	}
	/** The width every aligned item pads to, or null when nothing aligns. */
	#alignment(widths) {
		if (!this.options.alignAliases) return null;
		const aligned = widths.filter((width) => width !== null);
		return aligned.length === 0 ? null : Math.max(...aligned);
	}
	/** The width of `nodes` written inline at `column`, or null when that spans lines or passes the limit. */
	#singleLineWidth(column, nodes) {
		const measured = this.measure(column, (scratch) => {
			this.inline(scratch, nodes, false);
		});
		return measured.multiline || measured.width > 80 ? null : measured.width;
	}
	measure(column, render) {
		const scratch = new Writer(column);
		render(scratch);
		return {
			width: scratch.out.length,
			multiline: scratch.out.includes("\n") || scratch.endsInLineComment
		};
	}
	/** `SET a = 1,` with each further assignment under the first and the `=` lined up like aliases. */
	assignments(writer, nodes, column) {
		const { parts, commas } = splitTop(nodes, COMMA$1);
		const items = parts.map((part) => {
			const equals = part.findIndex((node) => node.type === "tok" && node.text === EQUALS);
			const target = equals > 0 ? part.slice(0, equals) : part;
			return {
				target,
				rest: equals > 0 ? part.slice(equals) : [],
				width: equals > 0 ? this.#singleLineWidth(column, target) : null
			};
		});
		const target = this.#alignment(items.map((item) => item.width));
		const saved = writer.indent;
		writer.indent = column;
		items.forEach((item, at) => {
			if (at > 0) writer.newline(column);
			this.inline(writer, item.target, at === 0);
			if (item.rest.length > 0) {
				if (target !== null && item.width !== null) writer.pad(target - item.width);
				this.inline(writer, item.rest, true);
			}
			const comma = commas[at];
			if (comma !== void 0) writer.tok(comma, comma.text, false);
		});
		writer.indent = saved;
	}
	/** Tables one per line under the first; each join on its own line at the same column (rules 7-8). */
	fromItems(writer, nodes, column) {
		const { parts, commas } = splitTop(nodes, COMMA$1);
		const saved = writer.indent;
		writer.indent = column;
		parts.forEach((part, at) => {
			if (at > 0) writer.newline(column);
			this.#fromItem(writer, part, column, at === 0);
			const comma = commas[at];
			if (comma !== void 0) writer.tok(comma, comma.text, false);
		});
		writer.indent = saved;
	}
	#fromItem(writer, nodes, column, leadSpace) {
		const starts = [];
		nodes.forEach((node, at) => {
			if (node.type !== "tok" || !node.keyword || !JOIN_WORDS.has(node.upper)) return;
			let start = at;
			while (start > 0 && JOIN_MODIFIERS.has(keywordAt(nodes, start - 1))) start -= 1;
			starts.push(start);
		});
		const bounds = [
			0,
			...starts,
			nodes.length
		];
		for (let segment = 0; segment + 1 < bounds.length; segment += 1) {
			const part = nodes.slice(bounds[segment], bounds[segment + 1]);
			if (part.length === 0) continue;
			if (segment === 0) {
				this.inline(writer, part, leadSpace);
				continue;
			}
			writer.newline(column);
			writer.indent = column;
			const on = part.findIndex((node) => isWord(node, "ON"));
			if (on < 0) {
				this.inline(writer, part, false);
				continue;
			}
			this.inline(writer, part.slice(0, on + 1), false);
			const keyword = part[on];
			this.conditions(writer, part.slice(on + 1), writer.column - this.text(keyword).length, writer.column);
		}
	}
	/**
	* The first condition on the keyword's line, each further `AND` / `OR` on its own line ending
	* where the keyword ends, or starting under it when the keyword is shorter (rule 9).
	*/
	conditions(writer, nodes, keywordStart, keywordEnd) {
		const saved = writer.indent;
		splitConditions(nodes).forEach((condition) => {
			let anchor = keywordStart;
			if (condition.operator !== null) {
				const text = this.text(condition.operator);
				anchor = Math.max(keywordStart, keywordEnd - text.length);
				writer.newline(anchor);
				writer.tok(condition.operator, text, false);
			}
			writer.indent = writer.column + 1;
			this.condition(writer, condition.nodes, anchor, true);
		});
		writer.indent = saved;
	}
	/** A parenthesised group of conditions too wide for its line opens one condition per line (rule 10). */
	condition(writer, nodes, anchor, leadSpace) {
		const group = nodes[nodes.length - 1];
		const prefix = nodes.slice(0, -1);
		if (!(group?.type === "group" && !isSubquery(group) && prefix.every((node) => isWord(node, "NOT")) && splitConditions(group.children).length > 1)) {
			this.inline(writer, nodes, leadSpace);
			return;
		}
		const start = writer.column + (leadSpace ? 1 : 0);
		const measured = this.measure(start, (scratch) => {
			this.inline(scratch, nodes, false);
		});
		if (!measured.multiline && start + measured.width <= 120) {
			this.inline(writer, nodes, leadSpace);
			return;
		}
		this.inline(writer, prefix, leadSpace);
		writer.tok(group.open, group.open.text, prefix.length > 0 || leadSpace);
		const inner = anchor + this.options.indentWidth;
		const saved = writer.indent;
		const parts = splitConditions(group.children);
		parts.forEach((part, at) => {
			writer.newline(inner);
			writer.indent = inner;
			this.condition(writer, part.nodes, inner, false);
			const next = parts[at + 1]?.operator ?? null;
			if (next !== null) writer.tok(next, this.text(next), true);
		});
		writer.tok(group.close, group.close.text, false);
		writer.indent = saved;
	}
	insert(writer, nodes, base) {
		let index = 0;
		const headEnd = nodes.findIndex((node, at) => at > 0 && (node.type === "tok" && node.kind === "word" && (node.upper === "VALUES" || node.upper === "VALUE" || isWord(node, "SET") || isWord(node, "SELECT") || isWord(node, "WITH") || isWord(node, "DEFAULT") && spells(nodes[at + 1], "VALUES")) || node.type === "group" && isSubquery(node)));
		const end = headEnd < 0 ? nodes.length : headEnd;
		const verb = nodes[0];
		verb.keyword = true;
		this.inline(writer, nodes.slice(0, end), false, { spaceBeforeGroup: true });
		index = end;
		if (index >= nodes.length) return;
		const tailAt = nodes.findIndex((node, at) => at > index && (isWord(node, "RETURNING") || isWord(node, "ON") && (spells(nodes[at + 1], "DUPLICATE") || spells(nodes[at + 1], "CONFLICT"))));
		const bodyEnd = tailAt < 0 ? nodes.length : tailAt;
		const body = nodes.slice(index, bodyEnd);
		writer.newline(base);
		writer.indent = base;
		const first = body[0];
		if (first?.type === "tok" && (first.upper === "VALUES" || first.upper === "VALUE")) {
			first.keyword = true;
			writer.tok(first, this.text(first), false);
			this.#rows(writer, body.slice(1), writer.column + 1);
		} else if (isWord(first, "SET")) {
			writer.tok(first, this.text(first), false);
			this.assignments(writer, body.slice(1), writer.column + 1);
		} else if (isWord(first, "DEFAULT")) {
			for (const node of body) if (node.type === "tok") node.keyword = true;
			this.inline(writer, body, false);
		} else this.statement(writer, body, base);
		if (tailAt >= 0) this.#insertTail(writer, nodes.slice(tailAt), base);
	}
	#insertTail(writer, nodes, base) {
		const returning = nodes.findIndex((node, at) => at > 0 && isWord(node, "RETURNING"));
		const clauses = returning < 0 ? [nodes] : [nodes.slice(0, returning), nodes.slice(returning)];
		for (const clause of clauses) {
			writer.newline(base);
			writer.indent = base;
			if (isWord(clause[0], "ON") && spells(clause[1], "DUPLICATE")) {
				const keywords = clause.slice(0, 4);
				if (!keywords.every((node) => node.type === "tok") || !spells(clause[3], "UPDATE")) throw new Unsupported("an ON DUPLICATE KEY without UPDATE");
				for (const keyword of keywords) keyword.keyword = true;
				this.#keywords(writer, keywords);
				this.assignments(writer, clause.slice(4), writer.column + 1);
			} else this.inline(writer, clause, false);
		}
	}
	#rows(writer, nodes, column) {
		const { parts, commas } = splitTop(nodes, COMMA$1);
		const saved = writer.indent;
		writer.indent = column;
		parts.forEach((part, at) => {
			if (at > 0) writer.newline(column);
			this.inline(writer, part, at === 0);
			const comma = commas[at];
			if (comma !== void 0) writer.tok(comma, comma.text, false);
		});
		writer.indent = saved;
	}
	update(writer, nodes, base) {
		const { head, clauses } = splitClauses(nodes, updateClauses);
		if (head.length > 0) throw new Unsupported("tokens before UPDATE");
		clauses.forEach((clause, at) => {
			if (at > 0) writer.newline(base);
			writer.indent = base;
			this.clause(writer, clause);
		});
	}
	delete(writer, nodes, base) {
		const { head, clauses } = splitClauses(nodes, deleteClauses);
		if (head.length > 0) throw new Unsupported("tokens before DELETE");
		const [verb, from] = clauses;
		const sameLine = from?.name === "FROM" && (verb?.body.every((node) => node.type === "tok" && node.kind === "word" && DELETE_MODIFIERS.has(node.upper)) ?? false);
		clauses.forEach((clause, at) => {
			if (at === 1 && sameLine) {
				this.#keywords(writer, clause.keywords, true);
				this.fromItems(writer, clause.body, writer.column + 1);
				return;
			}
			if (at > 0) writer.newline(base);
			writer.indent = base;
			this.clause(writer, clause);
		});
	}
	inline(writer, nodes, leadSpace, options = {}) {
		let previous = null;
		for (const node of nodes) {
			const space = previous === null ? leadSpace : this.#spaceBetween(previous, node, options);
			this.node(writer, node, space, options);
			previous = node;
		}
	}
	node(writer, node, space, options = {}) {
		if (node.type === "tok") writer.tok(node, this.text(node), space);
		else if (node.type === "group") this.#group(writer, node, space, options);
		else this.#case(writer, node, space);
	}
	#group(writer, group, space, options) {
		writer.tok(group.open, group.open.text, space);
		if (isSubquery(group) && options.preserve !== true) this.#nested(writer, group.children);
		else this.inline(writer, group.children, false, { preserve: options.preserve ?? false });
		writer.tok(group.close, group.close.text, false);
	}
	/** Inline when it fits `CASE_INLINE_LIMIT`; else `WHEN` / `ELSE` one per line under `CASE`, `END` at its column (rule 14). */
	#case(writer, node, space) {
		const start = writer.column + (space ? 1 : 0);
		const measured = this.measure(start, (scratch) => {
			this.#caseInline(scratch, node, false);
		});
		if (!measured.multiline && measured.width <= 60) {
			this.#caseInline(writer, node, space);
			return;
		}
		const headText = this.text(node.head);
		writer.tok(node.head, headText, space);
		const column = writer.column - headText.length;
		const branches = [[]];
		for (const child of node.children) {
			if (isWord(child, "WHEN") || isWord(child, "ELSE")) branches.push([]);
			branches[branches.length - 1]?.push(child);
		}
		const [operand = [], ...rest] = branches;
		this.inline(writer, operand, true);
		const saved = writer.indent;
		const inner = column + this.options.indentWidth;
		for (const branch of rest) {
			writer.newline(inner);
			writer.indent = inner;
			this.inline(writer, branch, false);
		}
		writer.newline(column);
		writer.indent = saved;
		writer.tok(node.end, this.text(node.end), false);
	}
	#caseInline(writer, node, space) {
		writer.tok(node.head, this.text(node.head), space);
		this.inline(writer, node.children, true);
		writer.tok(node.end, this.text(node.end), true);
	}
	#spaceBetween(previous, current, options) {
		const before = lastTok(previous);
		const after = firstTok(current);
		if (options.preserve === true) return after.spaced;
		if (after.text === COMMA$1) return false;
		if (before.text === COMMA$1) return true;
		if (before.text === CAST || after.text === CAST) return false;
		if (current.type === "group") {
			if (before.kind === "word") {
				if (before.keyword) return true;
				return options.spaceBeforeGroup === true && previous.type === "tok";
			}
			if (before.kind === "quoted" && options.spaceBeforeGroup === true) return true;
			if (isSpacedOperator(before)) return true;
			return after.spaced;
		}
		if (isSpacedOperator(before) || isSpacedOperator(after)) return true;
		if (before.kind === "word" && after.kind === "word") return true;
		if (previous.type !== "tok" && after.kind === "word") return true;
		return after.spaced;
	}
};
// ../plugin-api/src/sql/layout.ts
var LINE_BREAK = "\n";
var DELIMITER$1 = ";";
var SPACE = " ";
/** The statements of `text` with the comments around them, so none is lost between statements. */
function segment(text, dialect) {
	const lexer = new Lexer(text, dialect);
	const pieces = [];
	let cursor = 0;
	for (const span of sqlSplitter(dialect)(text)) {
		lexer.position = cursor;
		let start = span.from;
		for (let token = lexer.next(); token !== null && token.from < span.from; token = lexer.next()) if (token.kind === "comment") {
			start = token.from;
			break;
		}
		lexer.position = span.to;
		let end = span.to;
		let delimited = false;
		for (let token = lexer.next(); token !== null; token = lexer.next()) {
			if (token.kind === "comment") {
				end = token.to;
				continue;
			}
			delimited = token.kind === "delimiter";
			cursor = delimited ? token.to : end;
			break;
		}
		if (!delimited) cursor = end;
		const after = [];
		if (delimited) {
			lexer.position = cursor;
			for (let token = lexer.next(); token !== null && token.kind === "comment"; token = lexer.next()) {
				if (text.slice(cursor, token.from).includes(LINE_BREAK)) break;
				after.push(text.slice(token.from, token.to));
				cursor = token.to;
			}
		}
		pieces.push({
			text: text.slice(start, end),
			delimited,
			after
		});
	}
	const tail = [];
	lexer.position = cursor;
	for (let token = lexer.next(); token !== null; token = lexer.next()) if (token.kind === "comment") tail.push(text.slice(token.from, token.to));
	return {
		pieces,
		tail
	};
}
function tokenStream(text, dialect) {
	const lexer = new Lexer(text, dialect);
	const stream = [];
	for (let token = lexer.next(); token !== null; token = lexer.next()) {
		const content = text.slice(token.from, token.to);
		stream.push(token.kind === "word" ? content.toUpperCase() : content);
	}
	return stream;
}
function sameTokens(before, after, dialect) {
	const expected = tokenStream(before, dialect);
	const actual = tokenStream(after, dialect);
	return expected.length === actual.length && expected.every((token, index) => token === actual[index]);
}
function lastIsLineComment(text, dialect) {
	const lexer = new Lexer(text, dialect);
	let last = null;
	for (let token = lexer.next(); token !== null; token = lexer.next()) last = token.kind === "comment" ? text.slice(token.from, token.to) : null;
	return last !== null && isLineComment(last);
}
/**
* The aligned layout (decision 061), statement by statement. A statement it does not read, or one
* whose tokens it would change, goes to `standard` as written (decision 062).
*/
function formatAligned(text, format, dialect, standard) {
	const { pieces, tail } = segment(text, dialect);
	if (pieces.length === 0) return standard(text);
	const printer = new AlignedPrinter(format);
	const statement = (sql) => {
		try {
			const parsed = parseStatement(sql, dialect);
			const printed = printer.print(parsed.nodes, parsed.tail);
			if (!sameTokens(sql, printed.text, dialect)) throw new Unsupported("the layout would change a token");
			return printed;
		} catch (cause) {
			if (!(cause instanceof Unsupported)) throw cause;
			const fallback = standard(sql);
			return {
				text: fallback,
				endsInLineComment: lastIsLineComment(fallback, dialect)
			};
		}
	};
	const joined = pieces.map((piece) => {
		const formatted = statement(piece.text);
		let block = formatted.text;
		if (piece.delimited) block += formatted.endsInLineComment ? "\n;" : DELIMITER$1;
		for (const comment of piece.after) block += SPACE + comment;
		return block;
	}).join(LINE_BREAK.repeat(format.linesBetweenStatements + 1));
	return tail.length === 0 ? joined : [joined, ...tail].join(LINE_BREAK);
}
// ../plugin-api/src/sql/format.ts
/** The `sql-formatter` dialects the built-in plugins use (decision 042). */
var FORMAT_DIALECTS = {
	postgresql,
	mysql,
	sqlite
};
var DELIMITER_COMMAND = "DELIMITER";
var DELIMITER_REFUSAL = "a DELIMITER line changes what ends a statement; reformat the statements between them.";
var UNREADABLE = "the text is not SQL the formatter can read.";
var NAMED_PREFIX$1 = ":";
var NUMBERED_PREFIX = "$";
var BLOCK_COMMENT_OPEN = "/*";
var STAND_IN_TAG = "table_craft_comment_";
function paramTypes(styles) {
	return {
		named: styles.includes("named") ? [NAMED_PREFIX$1] : [],
		numbered: styles.includes("numbered") ? [NUMBERED_PREFIX] : [],
		positional: styles.includes("positional")
	};
}
function startsALine(text, from) {
	const lineStart = text.lastIndexOf("\n", from - 1) + 1;
	return text.slice(lineStart, from).trim() === "";
}
function hasDelimiterCommand(text, dialect) {
	const lexer = new Lexer(text, dialect);
	for (let token = lexer.next(); token !== null; token = lexer.next()) if (token.kind === "word" && wordOf(text, token) === DELIMITER_COMMAND && startsALine(text, token.from)) return true;
	return false;
}
/**
* The library re-indents the continuation lines of a block comment. Each multi-line one goes in as
* a one-line stand-in, which it leaves alone, and comes back as written.
*/
function shieldBlockComments(text, dialect) {
	const lexer = new Lexer(text, dialect);
	const comments = [];
	let shielded = "";
	let at = 0;
	let salt = 0;
	while (text.includes(standIn(salt, 0))) salt += 1;
	for (let token = lexer.next(); token !== null; token = lexer.next()) {
		const content = text.slice(token.from, token.to);
		if (token.kind !== "comment" || !content.startsWith(BLOCK_COMMENT_OPEN) || !content.includes("\n")) continue;
		shielded += text.slice(at, token.from) + standIn(salt, comments.length);
		comments.push(content);
		at = token.to;
	}
	if (comments.length === 0) return {
		text,
		restore: (formatted) => formatted
	};
	return {
		text: shielded + text.slice(at),
		restore: (formatted) => comments.reduce((result, comment, index) => result.replace(standIn(salt, index), () => comment), formatted)
	};
}
function standIn(salt, index) {
	return `/*${STAND_IN_TAG}${String(salt)}_${String(index)}*/`;
}
/** The library's parse errors run to a page of grammar; the first line says where. */
function reasonOf(cause) {
	const firstLine = (cause instanceof Error ? cause.message : String(cause)).split("\n", 1)[0]?.trim() ?? "";
	return firstLine === "" ? UNREADABLE : firstLine;
}
/**
* `SqlLanguage.format`: the aligned layout (decision 061) or `sql-formatter`'s (decision 042), which
* also takes every statement the aligned one does not read (decision 062). Throws an `Error` with a
* one-line reason rather than returning half-formatted text; comments and literals pass through as
* written.
*/
function sqlFormatter(options) {
	const dialect = FORMAT_DIALECTS[options.dialect];
	const params = paramTypes(options.parameters);
	const standard = (text, format) => {
		const shielded = shieldBlockComments(text, options.lexer);
		try {
			return shielded.restore(formatDialect(shielded.text, {
				dialect,
				keywordCase: format.keywordCase,
				dataTypeCase: format.keywordCase,
				tabWidth: format.indentWidth,
				linesBetweenQueries: format.linesBetweenStatements,
				paramTypes: params
			}));
		} catch (cause) {
			throw new Error(reasonOf(cause), { cause });
		}
	};
	return { format(text, format) {
		if (options.lexer.delimiterCommand === true && hasDelimiterCommand(text, options.lexer)) throw new Error(DELIMITER_REFUSAL);
		if (format.style === "standard") return standard(text, format);
		return formatAligned(text, format, options.lexer, (statement) => standard(statement, format));
	} };
}
// ../plugin-api/src/sql/parameters.ts
var NAMED_PREFIX = ":";
var POSITIONAL_MARK = "?";
var NUMBERED = /^\$[1-9]\d*$/;
var NAME_START = /^[A-Za-z_\u0080-\uffff]/;
/** A `:` after one of these is a slice bound, a label or the second half of `::`, not a parameter. */
var NOT_BEFORE_NAMED = /[A-Za-z0-9_$:\u0080-\uffff\]]/;
function namedAt(text, colon, next) {
	if (next?.kind !== "word" || next.from !== colon.to) return null;
	if (!NAME_START.test(text.charAt(next.from))) return null;
	const before = colon.from > 0 ? text.charAt(colon.from - 1) : "";
	return NOT_BEFORE_NAMED.test(before) ? null : next;
}
function missingValue(name) {
	return new PluginError("statementFailed", `No value for the parameter ${name}; run the statement again and give it one.`);
}
/**
* Detection and binding of `:name`, `$1` and `?` placeholders on the lexer the splitter uses
* (decision 043), so nothing inside a string, quoted identifier, comment or dollar quote counts.
*/
function sqlParameters(options) {
	const styles = new Set(options.styles);
	const parameters = (statement) => {
		const lexer = new Lexer(statement, options.dialect);
		const found = [];
		let positional = 0;
		let token = lexer.next();
		while (token !== null) {
			const next = lexer.next();
			const text = statement.slice(token.from, token.to);
			if (token.kind === "symbol" && text === NAMED_PREFIX && styles.has("named")) {
				const name = namedAt(statement, token, next);
				if (name !== null) {
					found.push({
						name: statement.slice(token.from, name.to),
						from: token.from,
						to: name.to,
						style: "named"
					});
					token = lexer.next();
					continue;
				}
			} else if (token.kind === "symbol" && text === POSITIONAL_MARK && styles.has("positional")) {
				positional += 1;
				found.push({
					name: `${POSITIONAL_MARK}${String(positional)}`,
					from: token.from,
					to: token.to,
					style: "positional"
				});
			} else if (token.kind === "word" && styles.has("numbered") && NUMBERED.test(text)) found.push({
				name: text,
				from: token.from,
				to: token.to,
				style: "numbered"
			});
			token = next;
		}
		return found;
	};
	const bind = (statement, values) => {
		const found = parameters(statement);
		const params = [];
		const numbers = /* @__PURE__ */ new Map();
		let sql = "";
		let at = 0;
		for (const parameter of found) {
			if (!Object.hasOwn(values, parameter.name)) throw missingValue(parameter.name);
			const value = values[parameter.name] ?? null;
			let placeholder = POSITIONAL_MARK;
			if (options.native === "numbered") {
				let number = numbers.get(parameter.name);
				if (number === void 0) {
					params.push(value);
					number = params.length;
					numbers.set(parameter.name, number);
				}
				placeholder = `$${String(number)}`;
			} else params.push(value);
			sql += statement.slice(at, parameter.from) + placeholder;
			at = parameter.to;
		}
		return {
			sql: sql + statement.slice(at),
			params
		};
	};
	return {
		parameters,
		bind
	};
}
// ../plugin-api/src/sql/literals.ts
/** Quotes an identifier with `quote`, doubling any `quote` inside it, as SQL and MySQL both read it. */
function quoteIdentifierWith(quote) {
	return (name) => `${quote}${name.replaceAll(quote, quote + quote)}${quote}`;
}
/** The standard savepoint statements, which PostgreSQL, MySQL and SQLite all accept (plan 026). */
function sqlSavepoints(quoteIdentifier) {
	return (name) => {
		const quoted = quoteIdentifier(name);
		return {
			set: `SAVEPOINT ${quoted}`,
			rollback: `ROLLBACK TO SAVEPOINT ${quoted}`,
			release: `RELEASE SAVEPOINT ${quoted}`
		};
	};
}
/** The standard insert of a row made only of defaults, which PostgreSQL and SQLite accept. */
function defaultValuesInsert(qualifiedTable) {
	return `INSERT INTO ${qualifiedTable} DEFAULT VALUES`;
}
var BACKSLASH_ESCAPES = /* @__PURE__ */ new Map([
	["\\", "\\\\"],
	["'", "\\'"],
	["\0", "\\0"],
	["\n", "\\n"],
	["\r", "\\r"],
	["", "\\Z"]
]);
function quoteString(text, options) {
	if (options.backslashEscapes) return `'${Array.from(text, (char) => BACKSLASH_ESCAPES.get(char) ?? char).join("")}'`;
	return `'${text.replaceAll("'", "''")}'`;
}
var BYTES_PER_HEX_DIGIT = .5;
/**
* A literal any of the three built-in dialects reads back as the same value. Decimals, dates and
* JSON travel as text (decision 017), so they are written as strings and the column's type
* converts them; `columnType` is accepted for dialects that need a cast.
*/
function sqlLiteral(value, options) {
	if (value === null) return "NULL";
	switch (typeof value) {
		case "boolean": return value ? "TRUE" : "FALSE";
		case "number": return Number.isFinite(value) ? String(value) : quoteString(String(value), options);
		case "string": return quoteString(value, options);
	}
	switch (value.kind) {
		case "bigint": return value.value;
		case "json": return quoteString(value.text, options);
		case "date": return quoteString(value.iso, options);
		case "bytes": {
			const literal = options.bytes(value.preview);
			const shown = value.preview.length * BYTES_PER_HEX_DIGIT;
			return shown < value.length ? `${literal} /* ${String(shown)} of ${String(value.length)} bytes */` : literal;
		}
	}
}
// ../plugin-api/src/sql/generate.ts
var NULL = "NULL";
var INDENT$1 = "  ";
var DROP_KEYWORDS = {
	table: "DROP TABLE",
	view: "DROP VIEW",
	materializedView: "DROP MATERIALIZED VIEW"
};
/** The completer's rule, so a generated statement spells a name as completion inserts it. */
function identifierWriter(options) {
	const reserved = new Set(options.keywords.map((keyword) => keyword.toUpperCase()));
	return (identifier) => options.plainIdentifier.test(identifier) && !reserved.has(identifier.toUpperCase()) ? identifier : options.quoteIdentifier(identifier);
}
/** DROP, SELECT, INSERT and UPDATE for a catalog relation, which every built-in plugin spreads into its `SqlLanguage`. */
function sqlGenerator(options) {
	const name = identifierWriter(options);
	function list(columns) {
		return columns.map((column) => name(column.name)).join(", ");
	}
	function insertValue(column) {
		return column.default === null ? NULL : options.updateDefault(column.default);
	}
	function update(relation, qualifiedName) {
		const keyNames = new Set(relation.primaryKey?.columns ?? []);
		const keyed = keyNames.size > 0;
		const unkeyed = relation.columns.filter((column) => !keyNames.has(column.name));
		const set = unkeyed.length > 0 ? unkeyed : relation.columns;
		const where = keyed ? relation.columns.filter((column) => keyNames.has(column.name)) : relation.columns;
		return [
			`UPDATE ${qualifiedName}`,
			`SET ${set.map((column) => `${name(column.name)} = ${NULL}`).join(`,\n${INDENT$1}${INDENT$1}`)}`,
			`WHERE ${where.map((column) => `${name(column.name)} = ${NULL}`).join(`\n${INDENT$1}AND `)};`
		].join("\n");
	}
	return { generate(statement, relation, qualifiedName) {
		switch (statement) {
			case "drop": return `${DROP_KEYWORDS[relation.kind]} ${qualifiedName};`;
			case "select": return `SELECT ${list(relation.columns)}\nFROM ${qualifiedName};`;
			case "insert": {
				const assigned = relation.columns.filter((column) => !column.autoIncrement);
				const columns = assigned.length > 0 ? assigned : relation.columns;
				return `INSERT INTO ${qualifiedName} (${list(columns)})\nVALUES (${columns.map(insertValue).join(", ")});`;
			}
			case "update": return update(relation, qualifiedName);
		}
	} };
}
/** `importType` and `createTable` for a plugin that declares `bulkInsert` (decision 046). */
function sqlImporter(options) {
	const name = identifierWriter(options);
	return {
		importType: (column) => column.kind === "decimal" ? options.decimal(column) : options.types[column.kind],
		createTable: (qualifiedName, columns) => `CREATE TABLE ${qualifiedName} (\n${columns.map((column) => `${INDENT$1}${name(column.name)} ${column.type}`).join(",\n")}\n);`
	};
}
// ../plugin-api/src/sql/objects.ts
/** The action a dialect applies when a foreign key names none, which a design leaves null. */
var DEFAULT_ACTIONS = /* @__PURE__ */ new Set(["NO ACTION", "RESTRICT"]);
/** The referential actions a design may name, as SQL spells them. */
var REFERENTIAL_ACTIONS = [
	"CASCADE",
	"SET NULL",
	"SET DEFAULT",
	"RESTRICT",
	"NO ACTION"
];
/** A failure the user fixes in the dialog, so the host shows it as the dialog's error. */
function designError(message) {
	return new PluginError("statementFailed", message);
}
/**
* The design of a described table (decision 052). `columnDefault` turns the catalog's default into
* the expression a `DEFAULT` clause takes, for a dialect whose catalog stores it otherwise.
*/
function tableDesignOf(relation, columnDefault = (column) => column.default) {
	const primary = new Set(relation.primaryKey === null ? [] : [relation.primaryKey.name]);
	return {
		name: relation.name,
		comment: relation.comment,
		columns: relation.columns.map((column) => ({
			name: column.name,
			type: column.type,
			nullable: column.nullable,
			default: columnDefault(column),
			autoIncrement: column.autoIncrement,
			comment: column.comment,
			original: column.name
		})),
		primaryKey: relation.primaryKey?.columns ?? [],
		primaryKeyName: relation.primaryKey?.name ?? null,
		indexes: relation.indexes.filter((index) => !index.primary && !primary.has(index.name)).map((index) => ({
			name: index.name,
			columns: index.columns,
			unique: index.unique,
			original: index.name
		})),
		foreignKeys: relation.foreignKeys.map((key) => ({
			name: key.name,
			columns: key.columns,
			target: key.target,
			onDelete: referentialAction(key.onDelete),
			onUpdate: referentialAction(key.onUpdate),
			original: key.name
		})),
		checks: []
	};
}
function referentialAction(action) {
	const spelled = action.toUpperCase();
	return DEFAULT_ACTIONS.has(spelled) ? null : spelled;
}
function trimmed(text) {
	return text.trim();
}
/** Throws a `designError` naming the first thing in `design` no dialect can create. */
function validateDesign(design) {
	if (trimmed(design.name) === "") throw designError("Name the table.");
	if (design.columns.length === 0) throw designError("Add a column: a table needs at least one.");
	const names = /* @__PURE__ */ new Set();
	for (const column of design.columns) {
		if (trimmed(column.name) === "") throw designError("Name every column.");
		if (names.has(column.name)) throw designError(`Two columns are named ${column.name}; rename one.`);
		if (trimmed(column.type) === "") throw designError(`Give column ${column.name} a type.`);
		names.add(column.name);
	}
	const known = (columns, what) => {
		if (columns.length === 0) throw designError(`Pick the columns of ${what}.`);
		const missing = columns.find((column) => !names.has(column));
		if (missing !== void 0) throw designError(`${what} names column ${missing}, which the table does not have.`);
	};
	if (design.primaryKey.length > 0) known(design.primaryKey, "The primary key");
	for (const index of design.indexes) {
		if (trimmed(index.name) === "") throw designError("Name every index.");
		known(index.columns, `Index ${index.name}`);
	}
	for (const key of design.foreignKeys) {
		if (trimmed(key.name) === "") throw designError("Name every foreign key.");
		known(key.columns, `Foreign key ${key.name}`);
		if (trimmed(key.target.relation) === "") throw designError(`Pick the table foreign key ${key.name} references.`);
		for (const action of [key.onDelete, key.onUpdate]) if (action !== null && !REFERENTIAL_ACTIONS.some((known) => known === action)) throw designError(`Foreign key ${key.name} names action ${action}; pick one of ${REFERENTIAL_ACTIONS.join(", ")}.`);
		if (key.target.columns.length !== key.columns.length) throw designError(`Foreign key ${key.name} needs as many referenced columns as it has columns.`);
	}
	for (const check of design.checks) {
		if (trimmed(check.name) === "") throw designError("Name every check.");
		if (trimmed(check.expression) === "") throw designError(`Give check ${check.name} an expression.`);
	}
}
function sameList(left, right) {
	return left.length === right.length && left.every((item, index) => item === right[index]);
}
function sameIndex(left, right) {
	return left.name === right.name && left.unique === right.unique && sameList(left.columns, right.columns);
}
function sameForeignKey(left, right) {
	return left.name === right.name && sameList(left.columns, right.columns) && sameList(left.target.path, right.target.path) && left.target.relation === right.target.relation && sameList(left.target.columns, right.target.columns) && left.onDelete === right.onDelete && left.onUpdate === right.onUpdate;
}
function sameCheck(left, right) {
	return left.name === right.name && left.expression.trim() === right.expression.trim();
}
/** Whether a column's definition, everything but its name, differs. */
function columnChanged(before, after) {
	return before.type.trim() !== after.type.trim() || before.nullable !== after.nullable || (before.default ?? "").trim() !== (after.default ?? "").trim() || before.autoIncrement !== after.autoIncrement || (before.comment ?? "") !== (after.comment ?? "");
}
/**
* Parts matched by `original`: one whose original is gone from `after` was dropped, one without an
* original was added, and a changed index, key or check is dropped and added again.
*/
function partsDiff(before, after, same) {
	const kept = new Map(after.filter((part) => part.original !== null).map((part) => [part.original, part]));
	const dropped = [];
	const added = after.filter((part) => part.original === null);
	for (const part of before) {
		const next = kept.get(part.name);
		if (next === void 0) dropped.push(part);
		else if (!same(part, next)) {
			dropped.push(part);
			added.push(next);
		}
	}
	return {
		dropped,
		added
	};
}
function tableDifference(before, after) {
	const byOriginal = new Map(after.columns.filter((column) => column.original !== null).map((c) => [c.original, c]));
	const changedColumns = [];
	const droppedColumns = [];
	for (const column of before.columns) {
		const next = byOriginal.get(column.name);
		if (next === void 0) droppedColumns.push(column);
		else if (next.name !== column.name || columnChanged(column, next)) changedColumns.push({
			before: column,
			after: next
		});
	}
	const indexes = partsDiff(before.indexes, after.indexes, sameIndex);
	const foreignKeys = partsDiff(before.foreignKeys, after.foreignKeys, sameForeignKey);
	const checks = partsDiff(before.checks, after.checks, sameCheck);
	return {
		renamedTo: after.name === before.name ? null : after.name,
		commentChanged: (before.comment ?? "") !== (after.comment ?? ""),
		droppedColumns,
		addedColumns: after.columns.filter((column) => column.original === null),
		changedColumns,
		primaryKeyChanged: !sameList(before.primaryKey, after.primaryKey),
		droppedIndexes: indexes.dropped,
		addedIndexes: indexes.added,
		droppedForeignKeys: foreignKeys.dropped,
		addedForeignKeys: foreignKeys.added,
		droppedChecks: checks.dropped,
		addedChecks: checks.added
	};
}
/** Whether a difference holds no change at all. */
function unchanged(difference) {
	return difference.renamedTo === null && !difference.commentChanged && !difference.primaryKeyChanged && [
		difference.droppedColumns,
		difference.addedColumns,
		difference.changedColumns,
		difference.droppedIndexes,
		difference.addedIndexes,
		difference.droppedForeignKeys,
		difference.addedForeignKeys,
		difference.droppedChecks,
		difference.addedChecks
	].every((parts) => parts.length === 0);
}
/** A script of `statements` with nothing around them. */
function ddlScript(statements, options) {
	return {
		prepare: options.prepare ?? [],
		statements,
		verify: options.verify ?? [],
		finish: options.finish ?? [],
		transactional: options.transactional,
		notes: options.notes ?? []
	};
}
/** `NOTHING_TO_CHANGE` is the note an alter without a difference carries, so the dialog can say so. */
var NOTHING_TO_CHANGE = "The design matches the table; there is nothing to run.";
/** The `REFERENCES` tail of a foreign key, actions only where they differ from the default. */
function referencesClause(key, qualifiedTarget, name) {
	const actions = [key.onDelete === null ? "" : ` ON DELETE ${key.onDelete}`, key.onUpdate === null ? "" : ` ON UPDATE ${key.onUpdate}`].join("");
	return `FOREIGN KEY (${key.columns.map(name).join(", ")}) REFERENCES ${qualifiedTarget} (${key.target.columns.map(name).join(", ")})${actions}`;
}
// ../plugin-api/src/sql/explain.ts
var NOTHING_TO_EXPLAIN = "There is no statement to explain; put the caret in one.";
var EXPLAIN_ONE_STATEMENT = "Explain one statement at a time.";
var ALREADY_EXPLAIN = "This statement is already an EXPLAIN; run it with Run to see its rows.";
var CREATE = "CREATE";
var TABLE = "TABLE";
var AS = "AS";
/** How `ExplainableOptions` names `CREATE TABLE … AS`, which `CREATE TABLE` alone is not. */
var CREATE_TABLE_AS = "CREATE TABLE … AS";
function anyOf(items) {
	if (items.length <= 1) return items.join("");
	return `${items.slice(0, -1).join(", ")} or ${items.at(-1) ?? ""}`;
}
function isCreateTableAs(list) {
	if (list[0]?.word !== CREATE) return false;
	const table = list.findIndex((entry) => entry.depth === 0 && entry.word === TABLE);
	return table > 0 && list.some((entry, at) => at > table && entry.depth === 0 && entry.word === AS);
}
/**
* The refusals every dialect shares: nothing to explain, more than one statement, and a statement
* that already is an EXPLAIN. Null when none applies.
*/
function commonExplainRefusal(sql, dialect) {
	const spans = sqlSplitter(dialect)(sql);
	if (spans.length === 0) return NOTHING_TO_EXPLAIN;
	if (spans.length > 1) return EXPLAIN_ONE_STATEMENT;
	const first = words(sql, significantTokens(sql, dialect))[0]?.word;
	return first !== void 0 && EXPLAIN_VERBS$1.has(first) ? ALREADY_EXPLAIN : null;
}
/**
* The verb that decides what `sql` does, upper case: `SELECT`, the verb after `WITH …`, or
* `CREATE_TABLE_AS`; empty for no statement. A plugin picks its EXPLAIN format by it.
*/
function explainedVerb(sql, dialect) {
	const list = words(sql, significantTokens(sql, dialect));
	return isCreateTableAs(list) ? CREATE_TABLE_AS : list[mainVerb(list)]?.word ?? "";
}
/**
* `SqlLanguage.explainable` from a dialect's verb lists: the shared refusals, then the statement's
* main verb against what the dialect explains and analyses. A statement writes when it is not a read.
*/
function sqlExplainable(options) {
	const verbs = new Set(options.verbs);
	const analyzeVerbs = new Set(options.analyzeVerbs);
	const explainable = (sql, { analyze }) => {
		const common = commonExplainRefusal(sql, options.dialect);
		if (common !== null) return {
			ok: false,
			reason: common
		};
		const statement = sqlSplitter(options.dialect)(sql)[0]?.sql ?? sql;
		const verb = explainedVerb(statement, options.dialect);
		if (!verbs.has(verb)) return {
			ok: false,
			reason: `${options.name} cannot explain a ${verb} statement. Explain ${anyOf(options.verbs)} instead.`
		};
		if (analyze && !analyzeVerbs.has(verb)) return {
			ok: false,
			reason: analyzeVerbs.size === 0 ? `${options.name} cannot run Explain Analyse; use Explain Plan.` : `${options.name} analyses only ${anyOf(options.analyzeVerbs)} statements; use Explain Plan for this ${verb}.`
		};
		return {
			ok: true,
			writes: classifyTokens(statement, options.dialect).kind !== "read"
		};
	};
	return { explainable };
}
// ../../plugins/sqlite/src/errorPosition.ts
/** `near "frm": syntax error`, `no such column: nme`, `no such table: main.ordrs`. */
var NAMED_TOKEN = /^(?:near "([\s\S]+)": syntax error|no such (?:column|table): (\S+))$/;
var INCOMPLETE_INPUT = "incomplete input";
var WORD = /^\w+$/;
function occurrences(sql, token) {
	const found = [];
	const word = WORD.test(token);
	for (let at = sql.indexOf(token); at !== -1; at = sql.indexOf(token, at + 1)) {
		const before = sql[at - 1] ?? " ";
		const after = sql[at + token.length] ?? " ";
		if (!word || !/\w/.test(before) && !/\w/.test(after)) found.push(at);
	}
	return found;
}
/**
* SQLite names the token it stopped at but gives no offset, so the token is pointed at only when
* it occurs exactly once in the statement; a guess between two places would mislead. A qualified
* table name (`main.t`) is looked for as written and, failing that, without its schema.
*/
function sqliteErrorPosition(sql, message) {
	if (message === INCOMPLETE_INPUT) return { offset: sql.trimEnd().length };
	const match = NAMED_TOKEN.exec(message);
	const token = match?.[1] ?? match?.[2];
	if (token === void 0) return void 0;
	const candidates = token.includes(".") && match?.[2] !== void 0 ? [token, token.slice(token.indexOf(".") + 1)] : [token];
	for (const candidate of candidates) {
		const found = occurrences(sql, candidate);
		if (found.length === 1) return { offset: found[0] ?? 0 };
		if (found.length > 1) return void 0;
	}
}
// ../../plugins/sqlite/src/functions.ts
/** The shared functions plus a few SQLite ones, in our own words; the full list is a later plan. */
var SQLITE_FUNCTIONS = [
	...SQL_FUNCTIONS,
	...functionSpecs("datetime", [[
		"DATE",
		"time?, modifier... -> text",
		"The date part as YYYY-MM-DD, after applying any modifiers."
	], [
		"DATETIME",
		"time?, modifier... -> text",
		"Date and time as YYYY-MM-DD HH:MM:SS, after applying any modifiers."
	]]),
	...functionSpecs("aggregate", [[
		"GROUP_CONCAT",
		"expr, separator? -> text",
		"Joins the group's non-null values, with a comma unless told otherwise."
	]]),
	...functionSpecs("control", [[
		"IFNULL",
		"value, fallback -> value",
		"The first argument unless it is null."
	]]),
	...functionSpecs("json", [[
		"JSON_EXTRACT",
		"json, path... -> value",
		"The value at each path in a JSON text."
	]])
];
// ../../plugins/sqlite/src/explain.ts
/**
* What has a query plan in SQLite. `EXPLAIN QUERY PLAN` accepts any statement, but answers nothing
* for the rest, which would show an empty tree.
*/
var EXPLAIN_VERBS = [
	"SELECT",
	"VALUES",
	"INSERT",
	"REPLACE",
	"UPDATE",
	"DELETE",
	CREATE_TABLE_AS
];
function explainStatement(sql) {
	return `EXPLAIN QUERY PLAN ${sql}`;
}
/** The columns `EXPLAIN QUERY PLAN` answers: `id, parent, notused, detail`. */
var ID = 0;
var PARENT = 1;
var DETAIL = 3;
var TOP = 0;
/** Drawn the way the `sqlite3` shell prints a query plan. */
function drawn(roots) {
	const lines = ["QUERY PLAN"];
	const draw = (nodes, indent) => {
		nodes.forEach((node, index) => {
			const last = index === nodes.length - 1;
			lines.push(`${indent}${last ? "`--" : "|--"}${node.operation}`);
			draw(node.children, `${indent}${last ? "   " : "|  "}`);
		});
	};
	draw(roots, "");
	return lines.join("\n");
}
/** Reads `EXPLAIN QUERY PLAN` rows: each names its parent's id, and `detail` says what it does. */
function readPlanRows(rows, statement) {
	const byId = /* @__PURE__ */ new Map();
	const roots = [];
	for (const row of rows) {
		const detail = row[DETAIL];
		const node = {
			operation: typeof detail === "string" ? detail : "",
			target: null,
			detail: null,
			estimatedRows: null,
			estimatedCost: null,
			actualRows: null,
			actualTimeMs: null,
			loops: null,
			properties: [],
			children: []
		};
		const parent = byId.get(Number(row[PARENT]));
		if (Number(row[PARENT]) === TOP || parent === void 0) roots.push(node);
		else parent.children.push(node);
		byId.set(Number(row[ID]), node);
	}
	return {
		statement,
		analyzed: false,
		roots,
		summary: [],
		raw: drawn(roots)
	};
}
// ../../plugins/sqlite/src/introspect.ts
var MAIN_DATABASE = "main";
/** Where `CREATE TEMP TABLE` goes; it belongs to the connection, not the file. */
var TEMP_DATABASE = "temp";
/** Names SQLite reserves for its own tables, such as `sqlite_schema` and `sqlite_sequence`. */
var INTERNAL_PREFIX = "sqlite_";
var RELATION_TYPES = /* @__PURE__ */ new Map([
	["table", "table"],
	["virtual", "table"],
	["view", "view"]
]);
/** `pragma_table_xinfo.hidden` for a virtual table's hidden column; generated columns are 2 and 3. */
var HIDDEN_VIRTUAL_COLUMN = 1;
/** An `INTEGER PRIMARY KEY` aliases the rowid, which SQLite assigns when the insert omits it. */
var ROWID_ALIAS_TYPE = /^INTEGER$/i;
var UNIQUE_CONSTRAINT_ORIGIN = "u";
var PRIMARY_KEY_ORIGIN = "pk";
/** What `pragma_index_info` names an expression part, which has no column. */
var EXPRESSION_PART = "<expression>";
var DATABASES_SQL = "SELECT name FROM pragma_database_list ORDER BY seq";
var RELATIONS_SQL = "SELECT name, type FROM pragma_table_list WHERE schema = ?";
var COLUMNS_SQL = "SELECT name, type, \"notnull\", dflt_value, pk, hidden FROM pragma_table_xinfo(?, ?) ORDER BY cid";
var INDEXES_SQL = "SELECT name, \"unique\", origin FROM pragma_index_list(?, ?)";
var INDEX_PARTS_SQL = "SELECT name FROM pragma_index_info(?, ?) ORDER BY seqno";
var FOREIGN_KEYS_SQL = "SELECT id, \"table\", \"from\", \"to\", on_update, on_delete FROM pragma_foreign_key_list(?, ?) ORDER BY id, seq";
/** `sqlite_schema` keeps each object's statement as written; an index a constraint made has none. */
var definedRelationSql = (schema) => `SELECT sql FROM ${quote(schema)}.sqlite_master WHERE name = ? AND type IN ('table', 'view') AND sql IS NOT NULL`;
var definedPartsSql = (schema) => `SELECT sql FROM ${quote(schema)}.sqlite_master WHERE tbl_name = ? AND type IN ('index', 'trigger') AND sql IS NOT NULL ORDER BY type, name`;
function quote(identifier) {
	return `"${identifier.replaceAll("\"", "\"\"")}"`;
}
/** node:sqlite is synchronous; this turns a throw into a rejection coded as the contract expects. */
async function introspecting(work) {
	try {
		return work();
	} catch (cause) {
		if (cause instanceof PluginError) throw cause;
		throw new PluginError("introspectionFailed", cause instanceof Error ? cause.message : String(cause), { cause });
	}
}
/** Reads the `pragma_*` table-valued functions, one relation at a time; SQLite answers them from memory. */
function sqliteIntrospector(database) {
	function all(sql, ...values) {
		return database.prepare(sql).all(...values);
	}
	function databases() {
		return all(DATABASES_SQL).map((row) => row.name);
	}
	function primaryKeyColumns(schema, table) {
		return all(COLUMNS_SQL, table, schema).filter((column) => column.pk > 0).sort((left, right) => left.pk - right.pk).map((column) => column.name);
	}
	function columnRows(schema, name, kind) {
		try {
			return all(COLUMNS_SQL, name, schema);
		} catch (cause) {
			if (kind === "view") return [];
			throw cause;
		}
	}
	function describeRelation(schema, name, kind) {
		const rows = columnRows(schema, name, kind).filter((row) => row.hidden !== HIDDEN_VIRTUAL_COLUMN);
		const keyColumns = rows.filter((row) => row.pk > 0).sort((left, right) => left.pk - right.pk);
		const rowidAlias = keyColumns.length === 1 && ROWID_ALIAS_TYPE.test(keyColumns[0]?.type ?? "");
		const columns = rows.map((row, index) => ({
			name: row.name,
			position: index + 1,
			type: row.type,
			nullable: row.notnull === 0 && row.pk === 0,
			default: row.dflt_value,
			comment: null,
			autoIncrement: rowidAlias && row.pk > 0
		}));
		const indexRows = kind === "view" ? [] : all(INDEXES_SQL, name, schema);
		const indexes = indexRows.map((row) => ({
			name: row.name,
			columns: all(INDEX_PARTS_SQL, row.name, schema).map((part) => part.name ?? EXPRESSION_PART),
			unique: row.unique === 1,
			primary: row.origin === PRIMARY_KEY_ORIGIN
		}));
		const uniqueKeys = indexes.filter((index) => indexRows.find((row) => row.name === index.name)?.origin === UNIQUE_CONSTRAINT_ORIGIN).map((index) => ({
			name: index.name,
			columns: index.columns
		}));
		const foreignKeyRows = kind === "view" ? [] : all(FOREIGN_KEYS_SQL, name, schema);
		const foreignKeys = /* @__PURE__ */ new Map();
		for (const row of foreignKeyRows) foreignKeys.set(row.id, [...foreignKeys.get(row.id) ?? [], row]);
		return {
			name,
			kind,
			comment: null,
			columns,
			primaryKey: keyColumns.length === 0 ? null : {
				name: `${name}_pk`,
				columns: keyColumns.map((row) => row.name)
			},
			uniqueKeys: byName(uniqueKeys),
			foreignKeys: byName([...foreignKeys.values()].map((parts) => {
				const first = parts[0];
				const target = first?.table ?? "";
				const targetColumns = parts.every((part) => part.to !== null) ? parts.map((part) => part.to ?? "") : primaryKeyColumns(schema, target);
				return {
					name: `${name}_${target}_${targetColumns.join("_")}_fk`,
					columns: parts.map((part) => part.from),
					target: {
						path: [schema],
						relation: target,
						columns: targetColumns
					},
					onDelete: first?.on_delete ?? "NO ACTION",
					onUpdate: first?.on_update ?? "NO ACTION"
				};
			})),
			indexes: byName(indexes)
		};
	}
	return {
		namespaces: () => introspecting(() => databases().map((name) => ({
			path: [name],
			name,
			kind: "schema",
			system: name === TEMP_DATABASE,
			current: name === MAIN_DATABASE
		}))),
		describe: (path) => introspecting(() => {
			const [schema] = path;
			if (path.length !== 1 || schema === void 0 || !databases().includes(schema)) throw new PluginError("introspectionFailed", `"${path.join(".")}" is not an attached database.`);
			const relations = all(RELATIONS_SQL, schema).flatMap((row) => {
				const kind = RELATION_TYPES.get(row.type);
				if (kind === void 0 || row.name.startsWith(INTERNAL_PREFIX)) return [];
				return [describeRelation(schema, row.name, kind)];
			});
			return {
				path: [schema],
				relations: byName(relations),
				routines: [],
				sequences: []
			};
		}),
		definition: (path, name) => introspecting(() => {
			const [schema] = path;
			const relation = path.length === 1 && schema !== void 0 && databases().includes(schema) ? all(definedRelationSql(schema), name)[0] : void 0;
			if (relation === void 0 || schema === void 0) throw new DefinitionNotFoundError(path, name);
			return [relation, ...all(definedPartsSql(schema), name)].map((part) => `${part.sql};`).join("\n\n");
		}),
		qualifiedName: (path, name) => [...path, name].map(quote).join(".")
	};
}
// ../../plugins/sqlite/src/objects.ts
var INDENT = "  ";
var TYPES = [
	"INTEGER",
	"TEXT",
	"REAL",
	"NUMERIC",
	"BLOB",
	"BOOLEAN",
	"DATE",
	"TIMESTAMP"
];
/** Only `INTEGER PRIMARY KEY` aliases the rowid (https://sqlite.org/lang_createtable.html#rowid). */
var ROWID_TYPE = /^INTEGER$/i;
/** `ADD COLUMN` refuses a default in parentheses or a current time (https://sqlite.org/lang_altertable.html). */
var NON_CONSTANT_DEFAULT = /^\(|^CURRENT_(TIME|DATE|TIMESTAMP)\b/i;
/** The suffix the rebuild's new table carries until it takes the old one's name. */
var REBUILD_SUFFIX = "__table_craft_new";
/** Foreign keys are off while the old table is dropped, so its rows' references hold (https://sqlite.org/lang_altertable.html#otheralter). */
var FOREIGN_KEYS_OFF = "PRAGMA foreign_keys = OFF";
var FOREIGN_KEYS_ON = "PRAGMA foreign_keys = ON";
var REBUILD_NOTE = "SQLite cannot make this change in place, so the table is rebuilt: a new table is created, the rows are copied into it, the old table is dropped and the new one renamed. Its triggers and checks are dropped with the old table, and its indexes are created again from their columns.";
/** The name the design gives the index behind a `UNIQUE` constraint, which SQLite names internally. */
function uniqueKeyIndexName(table, columns) {
	return `${table}_${columns.join("_")}_key`;
}
/** Object DDL for SQLite. What `ALTER TABLE` cannot do is the documented twelve-step rebuild (decision 053). */
function sqliteObjects(options) {
	const { name } = options;
	function columns(list) {
		return list.map(name).join(", ");
	}
	function rowidColumn(design) {
		const marked = design.columns.filter((column) => column.autoIncrement);
		const [only] = marked;
		if (only === void 0) return null;
		if (marked.length > 1 || design.primaryKey.length !== 1 || design.primaryKey[0] !== only.name) throw designError("In SQLite only a lone INTEGER primary key column auto-increments; make it the primary key.");
		if (!ROWID_TYPE.test(only.type.trim())) throw designError(`Give auto-increment column ${only.name} type INTEGER.`);
		return only;
	}
	function columnDefinition(column, rowid) {
		const fallback = (column.default ?? "").trim();
		return [
			name(column.name),
			column.type.trim(),
			rowid ? "PRIMARY KEY" : "",
			column.nullable || rowid ? "" : "NOT NULL",
			fallback === "" ? "" : `DEFAULT ${fallback}`
		].filter((part) => part !== "").join(" ");
	}
	function foreignKey(key) {
		return `CONSTRAINT ${name(key.name)} ${referencesClause(key, name(key.target.relation), name)}`;
	}
	function check(entry) {
		return `CONSTRAINT ${name(entry.name)} CHECK (${entry.expression.trim()})`;
	}
	function createIndex(path, index, table, context) {
		return `CREATE ${index.unique ? "UNIQUE " : ""}INDEX ${context.qualifiedName(path, index.name)} ON ${name(table)} (${columns(index.columns)});`;
	}
	function createTableStatement(qualified, design) {
		const rowid = rowidColumn(design);
		return `CREATE TABLE ${qualified} (\n${[
			...design.columns.map((column) => columnDefinition(column, column === rowid)),
			...design.primaryKey.length > 0 && rowid === null ? [`PRIMARY KEY (${columns(design.primaryKey)})`] : [],
			...design.foreignKeys.map(foreignKey),
			...design.checks.map(check)
		].map((part) => INDENT + part).join(",\n")}\n);`;
	}
	function createTable(path, design, context) {
		validateDesign(design);
		return ddlScript([createTableStatement(context.qualifiedName(path, design.name), design), ...design.indexes.map((index) => createIndex(path, index, design.name, context))], { transactional: true });
	}
	/** Whether `ALTER TABLE` and index statements make the whole change, which leaves rows and triggers alone. */
	function inPlace(current, difference) {
		const keyed = /* @__PURE__ */ new Set([
			...current.primaryKey,
			...current.indexes.flatMap((index) => index.columns),
			...current.foreignKeys.flatMap((key) => key.columns)
		]);
		return !difference.primaryKeyChanged && !difference.commentChanged && difference.addedForeignKeys.length === 0 && difference.droppedForeignKeys.length === 0 && difference.addedChecks.length === 0 && difference.droppedChecks.length === 0 && difference.changedColumns.every(({ before, after }) => before.name !== after.name && sameDefinition(before, after)) && difference.droppedColumns.every((column) => !keyed.has(column.name)) && difference.addedColumns.every((column) => !column.autoIncrement && (column.nullable || (column.default ?? "").trim() !== "") && !NON_CONSTANT_DEFAULT.test((column.default ?? "").trim())) && difference.droppedIndexes.every((index) => index.name !== uniqueKeyIndexName(current.name, index.columns));
	}
	function sameDefinition(before, after) {
		return before.type.trim() === after.type.trim() && before.nullable === after.nullable && (before.default ?? "").trim() === (after.default ?? "").trim() && before.autoIncrement === after.autoIncrement;
	}
	function alterInPlace(path, current, design, difference, context) {
		const table = context.qualifiedName(path, current.name);
		const alter = (clause) => `ALTER TABLE ${table} ${clause};`;
		const finalName = difference.renamedTo ?? current.name;
		return ddlScript([
			...difference.droppedIndexes.map((index) => `DROP INDEX ${context.qualifiedName(path, index.name)};`),
			...difference.droppedColumns.map((column) => alter(`DROP COLUMN ${name(column.name)}`)),
			...difference.changedColumns.map(({ before, after }) => alter(`RENAME COLUMN ${name(before.name)} TO ${name(after.name)}`)),
			...difference.addedColumns.map((column) => alter(`ADD COLUMN ${columnDefinition(column, false)}`)),
			...difference.renamedTo === null ? [] : [alter(`RENAME TO ${name(difference.renamedTo)}`)],
			...difference.addedIndexes.map((index) => createIndex(path, index, finalName, context))
		], { transactional: true });
	}
	function rebuild(path, current, design, context) {
		const old = context.qualifiedName(path, current.name);
		const temporary = `${design.name}${REBUILD_SUFFIX}`;
		const copied = design.columns.filter((column) => column.original !== null);
		const [schema = ""] = path;
		return ddlScript([
			createTableStatement(context.qualifiedName(path, temporary), design),
			...copied.length > 0 ? [`INSERT INTO ${context.qualifiedName(path, temporary)} (${columns(copied.map((column) => column.name))})\nSELECT ${columns(copied.map((column) => column.original ?? column.name))}\nFROM ${old};`] : [],
			`DROP TABLE ${old};`,
			`ALTER TABLE ${context.qualifiedName(path, temporary)} RENAME TO ${name(design.name)};`,
			...design.indexes.map((index) => createIndex(path, index, design.name, context))
		], {
			transactional: true,
			prepare: [FOREIGN_KEYS_OFF],
			verify: [`PRAGMA ${name(schema)}.foreign_key_check(${name(design.name)})`],
			finish: [FOREIGN_KEYS_ON],
			notes: [REBUILD_NOTE]
		});
	}
	function alterTable(path, design, context) {
		validateDesign(design);
		rowidColumn(design);
		const current = context.current;
		if (current === null) throw designError("The table is not described; synchronize the data source and try again.");
		const difference = tableDifference(current, design);
		if (unchanged(difference)) return ddlScript([], {
			transactional: true,
			notes: [NOTHING_TO_CHANGE]
		});
		return inPlace(current, difference) ? alterInPlace(path, current, design, difference, context) : rebuild(path, current, design, context);
	}
	function script(change, context) {
		switch (change.kind) {
			case "createTable": return createTable(change.path, change.design, context);
			case "alterTable": return alterTable(change.path, change.design, context);
			case "rename":
				if (change.name.trim() === "") throw designError("Type the new name.");
				if (change.object.kind !== "table") throw designError("SQLite renames only tables; drop the view and create it again under the new name.");
				return ddlScript([`ALTER TABLE ${context.qualifiedName(change.path, change.object.name)} RENAME TO ${name(change.name)};`], { transactional: true });
			case "drop":
				if (change.object.kind !== "table" && change.object.kind !== "view") throw designError(`SQLite has no ${change.object.kind} to drop.`);
				return ddlScript([`DROP ${change.object.kind === "table" ? "TABLE" : "VIEW"} ${context.qualifiedName(change.path, change.object.name)};`], { transactional: true });
			case "truncate": return ddlScript([`DELETE FROM ${context.qualifiedName(change.path, change.relation)};`], { transactional: true });
			case "createNamespace": throw designError("SQLite attaches databases rather than creating schemas; attach a file in the data source.");
		}
	}
	function design(relation) {
		const uniqueKeys = new Set(relation.uniqueKeys.map((key) => key.name));
		const base = tableDesignOf(relation);
		return {
			...base,
			indexes: base.indexes.map((index) => {
				if (!uniqueKeys.has(index.name)) return index;
				const generated = uniqueKeyIndexName(relation.name, index.columns);
				return {
					...index,
					name: generated,
					original: generated
				};
			})
		};
	}
	return {
		features: {
			types: TYPES,
			checks: true,
			comments: false,
			cascade: false,
			truncate: true,
			namespaceKind: null,
			renamable: ["table"],
			droppable: ["table", "view"]
		},
		design,
		script
	};
}
// ../../plugins/sqlite/src/index.ts
var PLUGIN_ID = "sqlite";
/** No `cancel`: node:sqlite runs a statement synchronously, so nothing could deliver the request. */
var CAPABILITIES = [
	"sql",
	"schemaTree",
	"transactions",
	"ddl",
	"explain",
	"bulkInsert",
	"objects"
];
/** Trigger bodies are `BEGIN … END` and hold semicolons. */
var DIALECT = { blockKeywords: ["BEGIN"] };
var PARAMETERS = {
	dialect: DIALECT,
	styles: ["named", "positional"],
	native: "positional"
};
var LITERALS = {
	backslashEscapes: false,
	bytes: (hex) => `X'${hex}'`
};
var quoteIdentifier = quoteIdentifierWith("\"");
/** SQLite has no `DEFAULT` inside `SET`; `dflt_value` is the declared expression, valid SQL as written. */
var updateDefault = (expression) => expression ?? "NULL";
var PLAIN_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_$]*$/;
var KEYWORDS = [
	...SQL_KEYWORDS,
	"GLOB",
	"PRAGMA"
];
/** No `explainAnalyze`: SQLite's `EXPLAIN QUERY PLAN` only plans, and nothing else reports run times. */
var { explainable } = sqlExplainable({
	dialect: DIALECT,
	name: "SQLite",
	verbs: EXPLAIN_VERBS,
	analyzeVerbs: []
});
var language = {
	split: sqlSplitter(DIALECT),
	splitStream: sqlStatementStream(DIALECT),
	classify: (sql) => classifyTokens(sql, DIALECT),
	quoteIdentifier,
	literal: (value) => sqlLiteral(value, LITERALS),
	emptyInsert: defaultValuesInsert,
	updateDefault,
	savepoint: sqlSavepoints(quoteIdentifier),
	...sqlCompleter({
		dialect: DIALECT,
		identifierFolding: "none",
		plainIdentifier: PLAIN_IDENTIFIER,
		quoteIdentifier,
		keywords: KEYWORDS,
		functions: SQLITE_FUNCTIONS
	}),
	...sqlGenerator({
		quoteIdentifier,
		updateDefault,
		plainIdentifier: PLAIN_IDENTIFIER,
		keywords: KEYWORDS
	}),
	explainable,
	...sqlFormatter({
		dialect: "sqlite",
		lexer: DIALECT,
		parameters: PARAMETERS.styles
	}),
	...sqlParameters(PARAMETERS),
	...sqlImporter({
		quoteIdentifier,
		plainIdentifier: PLAIN_IDENTIFIER,
		keywords: KEYWORDS,
		types: {
			boolean: "BOOLEAN",
			integer: "INTEGER",
			bigint: "INTEGER",
			double: "REAL",
			date: "DATE",
			timestamp: "TIMESTAMP",
			text: "TEXT"
		},
		decimal: () => "NUMERIC"
	}),
	objects: sqliteObjects({ name: identifierWriter({
		quoteIdentifier,
		plainIdentifier: PLAIN_IDENTIFIER,
		keywords: KEYWORDS
	}) })
};
var BEGIN_SQL = "BEGIN";
var COMMIT_SQL = "COMMIT";
var ROLLBACK_SQL = "ROLLBACK";
/** Each batch of an import is atomic inside the import's transaction (decision 046). */
var SAVEPOINT_SQL = "SAVEPOINT table_craft_insert";
var RELEASE_SQL = "RELEASE SAVEPOINT table_craft_insert";
var ROLLBACK_TO_SQL = "ROLLBACK TO SAVEPOINT table_craft_insert";
/** SQLITE_MAX_VARIABLE_NUMBER since 3.32. */
var MAX_PARAMETERS = 32766;
/** How the exporter writes bytes (`cellText`): `0x` and hex. */
var EXPORTED_BYTES = /^0x([0-9a-fA-F]*)$/u;
var BLOB_DECLARATION = /BLOB/iu;
var BOOLEAN_TEXT = /* @__PURE__ */ new Map([["true", 1], ["false", 0]]);
var OPEN_TRANSACTION_MESSAGE = "A transaction is open; commit or roll it back before switching to auto-commit.";
var connectionSchema = strictObject({ 
/** A file path, or `:memory:` for a private in-memory database. */
path: string$1().min(1) });
/**
* SQLite stores booleans as integers and JSON as text; the declared column type is the only
* place the intent survives, so it decides the wire value (decision 017).
*/
var BOOLEAN_DECLARATION = /^BOOL(EAN)?$/i;
var JSON_DECLARATION = /^JSONB?$/i;
/** What the exporter wrote, as the declared type wants it: bytes for `0x…` in a BLOB, 1/0 for a BOOLEAN's text. */
function bound(value, declared) {
	if (value === null || declared === null) return value;
	if (BLOB_DECLARATION.test(declared)) {
		const hex = EXPORTED_BYTES.exec(value);
		if (hex !== null) return Buffer.from(hex[1] ?? "", "hex");
	}
	if (BOOLEAN_DECLARATION.test(declared)) return BOOLEAN_TEXT.get(value.toLowerCase()) ?? value;
	return value;
}
function plainCell(value) {
	return typeof value === "bigint" ? toWireInteger(value) : toWireValue(value);
}
function wholeCell(value) {
	return typeof value === "bigint" ? toWireInteger(value) : toWireValue(value, { fullBytes: true });
}
function cellFor(column, options) {
	const plain = options.fullBytes === true ? wholeCell : plainCell;
	const declared = column.type ?? "";
	if (BOOLEAN_DECLARATION.test(declared)) return (value) => value === 0n || value === 1n ? value === 1n : plain(value);
	if (JSON_DECLARATION.test(declared)) return (value) => typeof value === "string" ? {
		kind: "json",
		text: value
	} : plain(value);
	return plain;
}
/** node:sqlite is synchronous; this turns a throw into a rejection coded as the contract expects. */
async function settle(code, work, sql) {
	try {
		return work();
	} catch (cause) {
		const message = cause instanceof Error ? cause.message : String(cause);
		throw new PluginError(code, message, {
			cause,
			position: sql === void 0 ? void 0 : sqliteErrorPosition(sql, message)
		});
	}
}
function readRows(rows, cells) {
	const iterator = {
		next: () => settle("statementFailed", () => {
			const next = rows.next();
			if (next.done === true) return {
				done: true,
				value: void 0
			};
			return {
				done: false,
				value: next.value.map((value, index) => (cells[index] ?? plainCell)(value))
			};
		}),
		return: () => settle("statementFailed", () => {
			rows.return?.();
			return {
				done: true,
				value: void 0
			};
		})
	};
	return { [Symbol.asyncIterator]: () => iterator };
}
var VERSION_SQL = "SELECT sqlite_version() AS version";
/** SQLite's name for a database private to its connection; an empty path makes a private temporary one. */
var MEMORY_PATH = ":memory:";
/** Refuses every write on this connection, temporary tables included. */
var READ_ONLY_SQL = "PRAGMA query_only = ON";
/**
* SQLite reports whether a transaction is open (`isTransaction`), so `open` is read, not tracked.
* Everything runs synchronously, so every method has settled before it returns.
*/
var SqliteSession = class {
	#database;
	#mode = "auto";
	serverVersion;
	privateDatabase;
	introspector;
	transactions;
	constructor(config, options) {
		this.#database = new DatabaseSync(config.path);
		this.privateDatabase = config.path === MEMORY_PATH || config.path === "";
		this.introspector = sqliteIntrospector(this.#database);
		const database = this.#database;
		const mode = () => this.#mode;
		this.transactions = {
			setMode: (next) => settle("statementFailed", () => {
				if (next === "auto" && database.isTransaction) throw new Error(OPEN_TRANSACTION_MESSAGE);
				this.#mode = next;
			}),
			commit: () => this.#end(COMMIT_SQL),
			rollback: () => this.#end(ROLLBACK_SQL),
			get mode() {
				return mode();
			},
			get open() {
				return database.isOpen && database.isTransaction;
			}
		};
		if (options.readOnly) this.#database.exec(READ_ONLY_SQL);
		const row = this.#database.prepare(VERSION_SQL).get();
		this.serverVersion = typeof row?.version === "string" ? row.version : null;
	}
	execute(sql, params = [], options = {}) {
		return settle("statementFailed", () => {
			const database = this.#database;
			if (this.#mode === "manual" && !database.isTransaction && transactionEffect(sql, DIALECT) === null) database.exec(BEGIN_SQL);
			const statement = database.prepare(sql);
			statement.setReadBigInts(true);
			const columns = statement.columns().map((column) => ({
				name: column.name,
				type: column.type,
				origin: originOf(column)
			}));
			if (columns.length === 0) {
				const { changes } = statement.run(...params);
				return {
					columns,
					rows: readRows([].values(), []),
					rowsAffected: Number(changes)
				};
			}
			statement.setReturnArrays(true);
			return {
				columns,
				rows: readRows(statement.iterate(...params), columns.map((column) => cellFor(column, options))),
				rowsAffected: null
			};
		}, sql);
	}
	insertRows(target, rows) {
		return settle("statementFailed", () => {
			if (rows.length === 0) return;
			const database = this.#database;
			if (this.#mode === "manual" && !database.isTransaction) database.exec(BEGIN_SQL);
			const width = Math.max(1, target.columns.length);
			const perStatement = Math.max(1, Math.floor(MAX_PARAMETERS / width));
			const names = target.columns.map((column) => quoteIdentifier(column.name)).join(", ");
			const tuple = `(${target.columns.map(() => "?").join(", ")})`;
			database.exec(SAVEPOINT_SQL);
			try {
				for (let from = 0; from < rows.length; from += perStatement) {
					const chunk = rows.slice(from, from + perStatement);
					const values = [];
					for (const row of chunk) row.forEach((value, index) => values.push(bound(value, target.columns[index]?.type ?? null)));
					database.prepare(`INSERT INTO ${target.table} (${names}) VALUES ${chunk.map(() => tuple).join(", ")}`).run(...values);
				}
				database.exec(RELEASE_SQL);
			} catch (cause) {
				database.exec(ROLLBACK_TO_SQL);
				database.exec(RELEASE_SQL);
				throw cause;
			}
		});
	}
	async explain(sql, options) {
		const verdict = explainable(sql, options);
		if (!verdict.ok) throw new PluginError("explainUnsupported", verdict.reason);
		const statement = explainStatement(sql);
		const rows = [];
		for await (const row of (await this.execute(statement)).rows) rows.push(row);
		return readPlanRows(rows, statement);
	}
	#end(sql) {
		return settle("statementFailed", () => {
			if (this.#database.isTransaction) this.#database.exec(sql);
		});
	}
	close() {
		return settle("statementFailed", () => this.#database.close());
	}
};
var plugin = {
	id: PLUGIN_ID,
	capabilities: CAPABILITIES,
	language,
	connectionSchema,
	connect: (config, options) => settle("connectionFailed", () => new SqliteSession(connectionSchema.parse(config), options))
};
/** The table column better-sqlite3 reads a result column from, or null for an expression (plan 026). */
function originOf(column) {
	if (column.table === null || column.column === null) return null;
	return {
		table: `${column.database ?? ""}.${column.table}`,
		column: column.column
	};
}
export { plugin as default };
