export const extensionWorkerSource = String.raw`
import vm from "node:vm";
import { parentPort, workerData } from "node:worker_threads";

if (parentPort === null) {
	throw new Error("extension worker requires a parent port");
}

const revisionId = workerData.revisionId;
const source = workerData.source;
let duringActivation = false;
let extensionFn;
const handlers = new Map();
const pendingServices = new Map();
const abortedHandlers = new Set();
let nextServiceRequest = 0;

function post(message) {
	parentPort.postMessage(message);
}

function isObject(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function service(type, payload) {
	const requestId = "svc-" + (++nextServiceRequest);
	post({ type, requestId, payload });
	return new Promise((resolve, reject) => {
		pendingServices.set(requestId, { resolve, reject });
	});
}

function registerTool(manifest, handler) {
	if (!duringActivation) throw new Error("registerTool is only available during activation");
	if (!isObject(manifest) || typeof manifest.name !== "string") throw new Error("tool manifest must include a name");
	if (typeof handler !== "function") throw new Error("tool handler must be a function");
	handlers.set(manifest.name, handler);
	const requestId = "reg-tool-" + manifest.name + "-" + handlers.size;
	post({ type: "registerTool", requestId, manifest });
}

function registerPrompt(manifest) {
	if (!duringActivation) throw new Error("registerPrompt is only available during activation");
	if (!isObject(manifest) || typeof manifest.id !== "string" || typeof manifest.text !== "string") {
		throw new Error("prompt manifest must include id and text");
	}
	const requestId = "reg-prompt-" + manifest.id;
	post({ type: "registerPrompt", requestId, manifest });
}

function createFacade() {
	return Object.freeze({
		registerTool,
		registerPrompt,
		querySession: (request) => service("querySession", request),
		now: () => service("now", {}),
		id: () => service("id", {}),
	});
}

function serializeError(error) {
	return {
		message: error instanceof Error ? error.message : String(error),
	};
}

function freezeJson(value) {
	if (Array.isArray(value)) {
		for (const item of value) freezeJson(item);
		return Object.freeze(value);
	}
	if (isObject(value)) {
		for (const item of Object.values(value)) freezeJson(item);
		return Object.freeze(value);
	}
	return value;
}

async function activate(requestId) {
	try {
		const context = vm.createContext(Object.create(null), {
			codeGeneration: { strings: true, wasm: false },
		});
		const script = new vm.Script("(" + source + ")");
		const candidate = script.runInContext(context);
		if (typeof candidate !== "function") throw new Error("source did not evaluate to a function");
		extensionFn = candidate;
		duringActivation = true;
		const result = await extensionFn(createFacade());
		duringActivation = false;
		post({ type: "response", requestId, ok: true, result });
	} catch (error) {
		duringActivation = false;
		post({ type: "response", requestId, ok: false, error: serializeError(error) });
	}
}

async function callHandler(requestId, payload) {
	try {
		const { toolName, args, toolCallId } = payload;
		const handler = handlers.get(toolName);
		if (handler === undefined) throw new Error("unknown extension tool: " + toolName);
		const context = Object.freeze({
			signal: Object.freeze({
				get aborted() {
					return abortedHandlers.has(requestId);
				},
			}),
			toolCallId,
		});
		const result = await handler(freezeJson(args), context);
		post({ type: "response", requestId, ok: true, result });
	} catch (error) {
		post({ type: "response", requestId, ok: false, error: serializeError(error) });
	}
}

parentPort.on("message", (message) => {
	if (!isObject(message) || typeof message.type !== "string" || typeof message.requestId !== "string") {
		post({ type: "protocolError", requestId: "unknown", ok: false, error: { message: "malformed host message" } });
		return;
	}
	if (message.revisionId !== revisionId) {
		post({ type: "protocolError", requestId: message.requestId, ok: false, error: { message: "revision mismatch" } });
		return;
	}
	if (message.type === "activate") {
		void activate(message.requestId);
		return;
	}
	if (message.type === "callTool") {
		void callHandler(message.requestId, message.payload);
		return;
	}
	if (message.type === "abortHandler") {
		abortedHandlers.add(message.requestId);
		return;
	}
	if (message.type === "serviceResponse") {
		const pending = pendingServices.get(message.requestId);
		if (pending === undefined) return;
		pendingServices.delete(message.requestId);
		if (message.ok) pending.resolve(message.result);
		else pending.reject(new Error(message.error?.message ?? "host service failed"));
		return;
	}
	post({ type: "protocolError", requestId: message.requestId, ok: false, error: { message: "unknown host message type" } });
});
`;
