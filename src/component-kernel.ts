export type ComponentKind = "provider" | "tools" | "prompt" | "session-query" | "extension-runtime";

export type ComponentStatus = "active" | "replacing" | "stopped";

export type ComponentKernelErrorCode =
	| "COMPONENT_DEPENDENCY_CYCLE"
	| "COMPONENT_DEPENDENCY_MISSING"
	| "COMPONENT_DUPLICATE_ID"
	| "COMPONENT_NOT_FOUND"
	| "COMPONENT_NOT_REPLACEABLE"
	| "COMPONENT_REPLACE_BUSY"
	| "COMPONENT_ACTIVATED"
	| "COMPONENT_STOPPED"
	| "COMPONENT_REPLACING"
	| "COMPONENT_ACTIVATION_FAILED"
	| "COMPONENT_DISPOSE_FAILED";

export class ComponentKernelError extends Error {
	readonly code: ComponentKernelErrorCode;
	readonly cause: unknown;

	constructor(code: ComponentKernelErrorCode, message: string, options: { cause?: unknown } = {}) {
		super(message);
		this.name = "ComponentKernelError";
		this.code = code;
		this.cause = options.cause;
	}
}

export type ComponentDisposer = () => void | Promise<void>;

export interface ComponentActivationResult<Value = unknown> {
	readonly value: Value;
	readonly dispose?: ComponentDisposer;
}

export interface ComponentActivationContext {
	readonly dependencies: ReadonlyMap<string, ComponentHandle>;
	dependency<Value = unknown>(id: string): ComponentHandle<Value>;
}

export interface ComponentDefinition<Value = unknown> {
	readonly id: string;
	readonly kind: ComponentKind;
	readonly replaceable: boolean;
	readonly dependencies?: readonly string[];
	activate(context: ComponentActivationContext): Value | ComponentActivationResult<Value> | Promise<Value | ComponentActivationResult<Value>>;
}

export interface ComponentReceipt {
	readonly code: ComponentKernelErrorCode;
	readonly status: ComponentStatus;
	readonly message: string;
	readonly at: number;
}

export interface ComponentHandle<Value = unknown> {
	readonly id: string;
	readonly kind: ComponentKind;
	readonly dependencies: readonly string[];
	readonly replaceable: boolean;
	readonly value: Value;
	readonly status: ComponentStatus;
	readonly lastReceipt: ComponentReceipt;
}

export interface ComponentGraphEntry {
	readonly id: string;
	readonly kind: ComponentKind;
	readonly dependencies: readonly string[];
	readonly replaceable: boolean;
	readonly status: ComponentStatus;
	readonly lastReceipt?: ComponentReceipt;
}

export interface ComponentGraphSnapshot {
	readonly components: readonly ComponentGraphEntry[];
}

export interface ComponentKernelOptions {
	readonly isIdle?: () => boolean;
	readonly now?: () => number;
}

interface ComponentRecord<Value = unknown> {
	definition: ComponentDefinition<Value>;
	dependencies: readonly string[];
	value?: Value;
	dispose?: ComponentDisposer;
	status: ComponentStatus;
	lastReceipt?: ComponentReceipt;
	order?: number;
}

export class ComponentKernel {
	readonly #records = new Map<string, ComponentRecord>();
	readonly #isIdle: () => boolean;
	readonly #now: () => number;
	#nextOrder = 0;

	constructor(options: ComponentKernelOptions = {}) {
		this.#isIdle = options.isIdle ?? (() => true);
		this.#now = options.now ?? Date.now;
	}

	register<Value>(definition: ComponentDefinition<Value>): void {
		const existing = this.#records.get(definition.id);
		if (existing?.status === "active" || existing?.status === "replacing") {
			throw new ComponentKernelError("COMPONENT_DUPLICATE_ID", `component ${definition.id} is already active`);
		}

		const record = this.#createRecord(definition);
		this.#records.set(definition.id, record);
	}

	async activate<Value>(definitionOrId: ComponentDefinition<Value> | string): Promise<ComponentHandle<Value>> {
		if (typeof definitionOrId !== "string") {
			this.register(definitionOrId);
			return this.activate(definitionOrId.id) as Promise<ComponentHandle<Value>>;
		}

		await this.#activateById(definitionOrId, []);
		const handle = this.get<Value>(definitionOrId);
		if (!handle) {
			throw new ComponentKernelError("COMPONENT_NOT_FOUND", `component ${definitionOrId} was not activated`);
		}
		return handle;
	}

	get<Value = unknown>(id: string): ComponentHandle<Value> | undefined {
		const record = this.#records.get(id);
		if (!record || record.status !== "active" || !record.lastReceipt) {
			return undefined;
		}
		return this.#handle(record as ComponentRecord<Value>);
	}

	async replace<Value>(id: string, nextDefinition: ComponentDefinition<Value>): Promise<ComponentHandle<Value>> {
		if (id !== nextDefinition.id) {
			throw new ComponentKernelError("COMPONENT_NOT_FOUND", `replacement id ${nextDefinition.id} does not match ${id}`);
		}
		if (!this.#isIdle()) {
			throw new ComponentKernelError("COMPONENT_REPLACE_BUSY", `component ${id} cannot be replaced while the host is busy`);
		}

		const previous = this.#requireRecord(id);
		if (!previous.definition.replaceable) {
			throw new ComponentKernelError("COMPONENT_NOT_REPLACEABLE", `component ${id} is not replaceable`);
		}

		const previousSnapshot = { ...previous };
		const dependentIds = this.#collectDependents(id).filter((dependentId) => dependentId !== id);
		previous.status = "replacing";
		previous.lastReceipt = this.#receipt("COMPONENT_REPLACING", "replacing", `component ${id} is being replaced`);
		const nextRecord = this.#createRecord(nextDefinition);
		nextRecord.status = "replacing";
		let nextActivated = false;
		let previousDisposed = false;

		try {
			await this.#activateRecord(nextRecord);
			nextActivated = true;
			for (const dependentId of dependentIds) {
				await this.#disposeRecord(this.#requireRecord(dependentId));
			}
			await this.#disposeRecord(previousSnapshot);
			previousDisposed = true;
			for (const dependentId of dependentIds) {
				const dependent = this.#requireRecord(dependentId);
				dependent.status = "stopped";
				dependent.value = undefined;
				dependent.dispose = undefined;
				dependent.order = undefined;
			}
			this.#records.set(id, nextRecord);
			for (const dependentId of dependentIds.toReversed()) {
				await this.#activateById(dependentId, []);
			}
			return this.#handle(this.#requireRecord(id) as ComponentRecord<Value>);
		} catch (error) {
			if (nextActivated) {
				await this.#disposeRecord(nextRecord).catch(() => undefined);
			}
			const failedReceipt = error instanceof ComponentKernelError
				? this.#receipt(error.code, "active", error.message)
				: this.#receipt("COMPONENT_ACTIVATION_FAILED", "active", `component ${id} activation failed`);
			if (previousDisposed) {
				const restored = this.#createRecord(previousSnapshot.definition);
				this.#records.set(id, restored);
				await this.#activateById(id, []);
				for (const dependentId of dependentIds.toReversed()) {
					const dependent = this.#requireRecord(dependentId);
					if (dependent.status !== "active") await this.#activateById(dependentId, []);
				}
				this.#requireRecord(id).lastReceipt = failedReceipt;
			} else {
				this.#records.set(id, { ...previousSnapshot, status: "active", lastReceipt: failedReceipt });
			}
			if (error instanceof ComponentKernelError) {
				throw error;
			}
			throw new ComponentKernelError("COMPONENT_ACTIVATION_FAILED", `component ${id} activation failed`, { cause: error });
		}
	}

	async stop(id: string): Promise<void> {
		const stopIds = this.#collectDependents(id);
		if (stopIds.length === 0) {
			throw new ComponentKernelError("COMPONENT_NOT_FOUND", `component ${id} is not active`);
		}

		const disposed: ComponentRecord[] = [];
		for (const stopId of stopIds) {
			const record = this.#requireRecord(stopId);
			try {
				await this.#disposeRecord(record);
				disposed.push(record);
			} catch (error) {
				const componentError = error instanceof ComponentKernelError
					? error
					: new ComponentKernelError("COMPONENT_DISPOSE_FAILED", `component ${stopId} disposal failed`, { cause: error });
				record.lastReceipt = this.#receipt("COMPONENT_DISPOSE_FAILED", record.status, componentError.message);
				throw componentError;
			}
		}
		for (const record of disposed) {
			record.status = "stopped";
			record.value = undefined;
			record.dispose = undefined;
			record.order = undefined;
			record.lastReceipt = this.#receipt("COMPONENT_STOPPED", "stopped", `component ${record.definition.id} stopped`);
		}
	}

	async dispose(): Promise<void> {
		const activeIds = [...this.#records.values()]
			.filter((record) => record.status === "active")
			.toSorted((left, right) => (right.order ?? 0) - (left.order ?? 0))
			.map((record) => record.definition.id);

		for (const id of activeIds) {
			const record = this.#requireRecord(id);
			if (record.status !== "active") {
				continue;
			}
			try {
				await this.#disposeRecord(record);
				record.status = "stopped";
				record.value = undefined;
				record.dispose = undefined;
				record.order = undefined;
				record.lastReceipt = this.#receipt("COMPONENT_STOPPED", "stopped", `component ${id} stopped`);
			} catch (error) {
				const componentError = error instanceof ComponentKernelError
					? error
					: new ComponentKernelError("COMPONENT_DISPOSE_FAILED", `component ${id} disposal failed`, { cause: error });
				record.lastReceipt = this.#receipt("COMPONENT_DISPOSE_FAILED", record.status, componentError.message);
				throw componentError;
			}
		}
	}

	snapshot(): ComponentGraphSnapshot {
		const components = [...this.#records.values()].map((record): ComponentGraphEntry => Object.freeze({
			id: record.definition.id,
			kind: record.definition.kind,
			dependencies: Object.freeze([...record.dependencies]),
			replaceable: record.definition.replaceable,
			status: record.status,
			lastReceipt: record.lastReceipt ? Object.freeze({ ...record.lastReceipt }) : undefined,
		}));
		return Object.freeze({ components: Object.freeze(components) });
	}

	async #activateById(id: string, path: readonly string[]): Promise<void> {
		const record = this.#records.get(id);
		if (!record) {
			throw new ComponentKernelError("COMPONENT_DEPENDENCY_MISSING", `component ${id} is not registered`);
		}
		if (record.status === "active") {
			return;
		}
		if (path.includes(id)) {
			throw new ComponentKernelError("COMPONENT_DEPENDENCY_CYCLE", `component dependency cycle: ${[...path, id].join(" -> ")}`);
		}

		for (const dependencyId of record.dependencies) {
			if (!this.#records.has(dependencyId)) {
				throw new ComponentKernelError("COMPONENT_DEPENDENCY_MISSING", `component ${id} depends on missing ${dependencyId}`);
			}
			await this.#activateById(dependencyId, [...path, id]);
		}

		await this.#activateRecord(record);
	}

	async #activateRecord(record: ComponentRecord): Promise<void> {
		const id = record.definition.id;
		try {
			const dependencies = new Map(record.dependencies.map((dependencyId) => {
				const handle = this.get(dependencyId);
				if (!handle) {
					throw new ComponentKernelError("COMPONENT_DEPENDENCY_MISSING", `component ${id} depends on inactive ${dependencyId}`);
				}
				return [dependencyId, handle] as const;
			}));
			const result = await record.definition.activate(Object.freeze({
				dependencies,
				dependency: <Value = unknown>(dependencyId: string) => {
					const handle = dependencies.get(dependencyId);
					if (!handle) {
						throw new ComponentKernelError("COMPONENT_DEPENDENCY_MISSING", `dependency ${dependencyId} is not available to ${id}`);
					}
					return handle as ComponentHandle<Value>;
				},
			}));
			const activation = this.#normalizeActivation(result);
			record.value = activation.value;
			record.dispose = activation.dispose;
			record.status = "active";
			record.order = this.#nextOrder;
			this.#nextOrder += 1;
			record.lastReceipt = this.#receipt("COMPONENT_ACTIVATED", "active", `component ${id} activated`);
		} catch (error) {
			if (error instanceof ComponentKernelError) {
				record.lastReceipt = this.#receipt(error.code, record.status, error.message);
				throw error;
			}
			record.lastReceipt = this.#receipt("COMPONENT_ACTIVATION_FAILED", record.status, `component ${id} activation failed`);
			throw new ComponentKernelError("COMPONENT_ACTIVATION_FAILED", `component ${id} activation failed`, { cause: error });
		}
	}

	#collectDependents(id: string): string[] {
		const active = [...this.#records.values()].filter((record) => record.status === "active");
		if (!active.some((record) => record.definition.id === id)) {
			return [];
		}
		const selected = new Set([id]);
		let changed = true;
		while (changed) {
			changed = false;
			for (const record of active) {
				if (!selected.has(record.definition.id) && record.dependencies.some((dependencyId) => selected.has(dependencyId))) {
					selected.add(record.definition.id);
					changed = true;
				}
			}
		}
		return active
			.filter((record) => selected.has(record.definition.id))
			.toSorted((left, right) => (right.order ?? 0) - (left.order ?? 0))
			.map((record) => record.definition.id);
	}

	#createRecord<Value>(definition: ComponentDefinition<Value>): ComponentRecord<Value> {
		return {
			definition,
			dependencies: Object.freeze([...(definition.dependencies ?? [])]),
			status: "stopped",
		};
	}

	#requireRecord(id: string): ComponentRecord {
		const record = this.#records.get(id);
		if (!record) {
			throw new ComponentKernelError("COMPONENT_NOT_FOUND", `component ${id} is not registered`);
		}
		return record;
	}

	#handle<Value>(record: ComponentRecord<Value>): ComponentHandle<Value> {
		if (!record.lastReceipt) {
			throw new ComponentKernelError("COMPONENT_NOT_FOUND", `component ${record.definition.id} is not active`);
		}
		return Object.freeze({
			id: record.definition.id,
			kind: record.definition.kind,
			dependencies: Object.freeze([...record.dependencies]),
			replaceable: record.definition.replaceable,
			value: record.value as Value,
			status: record.status,
			lastReceipt: Object.freeze({ ...record.lastReceipt }),
		});
	}

	#normalizeActivation<Value>(result: Value | ComponentActivationResult<Value>): ComponentActivationResult<Value> {
		if (this.#isActivationResult(result)) {
			return result;
		}
		return { value: result };
	}

	#isActivationResult<Value>(result: Value | ComponentActivationResult<Value>): result is ComponentActivationResult<Value> {
		return typeof result === "object" && result !== null && "value" in result;
	}

	async #disposeRecord(record: ComponentRecord): Promise<void> {
		if (record.dispose) {
			await record.dispose();
		}
	}

	#receipt(code: ComponentKernelErrorCode, status: ComponentStatus, message: string): ComponentReceipt {
		return Object.freeze({
			code,
			status,
			message,
			at: this.#now(),
		});
	}
}
