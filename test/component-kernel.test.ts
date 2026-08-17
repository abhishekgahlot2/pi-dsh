import { describe, expect, it } from "vitest";
import {
	ComponentKernel,
	ComponentKernelError,
	type ComponentDefinition,
	type ComponentKind,
} from "../src/component-kernel.ts";

function component(
	id: string,
	options: {
		kind?: ComponentKind;
		dependencies?: readonly string[];
		replaceable?: boolean;
		onActivate?: () => unknown;
		onDispose?: () => unknown;
	} = {},
): ComponentDefinition<string> {
	return {
		id,
		kind: options.kind ?? "tools",
		dependencies: options.dependencies ?? [],
		replaceable: options.replaceable ?? true,
		activate: () => {
			options.onActivate?.();
			return {
				value: id,
				dispose: async () => {
					await options.onDispose?.();
				},
			};
		},
	};
}

async function expectComponentCode(action: () => unknown | Promise<unknown>, code: string) {
	try {
		await action();
		throw new Error(`expected ${code}`);
	} catch (error) {
		expect(error).toBeInstanceOf(ComponentKernelError);
		expect((error as ComponentKernelError).code).toBe(code);
	}
}

describe("ComponentKernel", () => {
	it("activates dependency graph in topological order", async () => {
		const order: string[] = [];
		const kernel = new ComponentKernel();

		kernel.register(component("provider:default", { kind: "provider", replaceable: false, onActivate: () => order.push("provider") }));
		kernel.register(component("tools:base", { dependencies: ["provider:default"], onActivate: () => order.push("tools") }));
		kernel.register(component("extension-runtime:default", { kind: "extension-runtime", dependencies: ["tools:base"], onActivate: () => order.push("extension") }));

		await kernel.activate("extension-runtime:default");

		expect(order).toEqual(["provider", "tools", "extension"]);
		expect(kernel.snapshot().components.map((entry) => entry.id)).toEqual([
			"provider:default",
			"tools:base",
			"extension-runtime:default",
		]);
	});

	it("disposes effects in reverse dependency order", async () => {
		const order: string[] = [];
		const kernel = new ComponentKernel();

		kernel.register(component("provider:default", { kind: "provider", replaceable: false, onDispose: () => order.push("provider") }));
		kernel.register(component("tools:base", { dependencies: ["provider:default"], onDispose: () => order.push("tools") }));
		kernel.register(component("prompt:base", { kind: "prompt", dependencies: ["tools:base"], onDispose: () => order.push("prompt") }));

		await kernel.activate("prompt:base");
		await kernel.dispose();

		expect(order).toEqual(["prompt", "tools", "provider"]);
		expect(kernel.snapshot().components.map((entry) => [entry.id, entry.status])).toEqual([
			["provider:default", "stopped"],
			["tools:base", "stopped"],
			["prompt:base", "stopped"],
		]);
	});

	it("rejects duplicate active component ids", async () => {
		const kernel = new ComponentKernel();

		await kernel.activate(component("tools:base"));

		await expectComponentCode(() => kernel.activate(component("tools:base")), "COMPONENT_DUPLICATE_ID");
	});

	it("rejects dependency cycles with a stable code", async () => {
		const kernel = new ComponentKernel();

		kernel.register(component("tools:a", { dependencies: ["tools:b"] }));
		kernel.register(component("tools:b", { dependencies: ["tools:a"] }));

		await expectComponentCode(() => kernel.activate("tools:a"), "COMPONENT_DEPENDENCY_CYCLE");
	});

	it("keeps provider graph-visible and non-replaceable", async () => {
		const kernel = new ComponentKernel();

		await kernel.activate(component("provider:default", { kind: "provider", replaceable: false }));

		const snapshot = kernel.snapshot();
		expect(snapshot.components).toEqual([
			expect.objectContaining({
				id: "provider:default",
				kind: "provider",
				replaceable: false,
				status: "active",
			}),
		]);

		await expectComponentCode(
			() => kernel.replace("provider:default", component("provider:default", { kind: "provider", replaceable: false })),
			"COMPONENT_NOT_REPLACEABLE",
		);
	});

	it("refuses replaceable component replacement while the host is not idle", async () => {
		const kernel = new ComponentKernel({ isIdle: () => false });

		await kernel.activate(component("tools:base"));

		await expectComponentCode(
			() => kernel.replace("tools:base", component("tools:base")),
			"COMPONENT_REPLACE_BUSY",
		);
	});

	it("rolls back to the previous active component if replacement activation fails", async () => {
		const disposed: string[] = [];
		const kernel = new ComponentKernel();

		await kernel.activate(component("tools:base", { onDispose: () => disposed.push("old") }));

		await expectComponentCode(
			() => kernel.replace("tools:base", {
				id: "tools:base",
				kind: "tools",
				replaceable: true,
				activate: () => {
					throw new Error("activation failed");
				},
			}),
			"COMPONENT_ACTIVATION_FAILED",
		);

		const handle = kernel.get<string>("tools:base");
		expect(handle?.value).toBe("tools:base");
		expect(handle?.status).toBe("active");
		expect(disposed).toEqual([]);
		expect(kernel.snapshot().components[0]).toEqual(expect.objectContaining({
			id: "tools:base",
			status: "active",
			lastReceipt: expect.objectContaining({ code: "COMPONENT_ACTIVATION_FAILED" }),
		}));
	});

	it("rebinds active dependents after a successful replacement", async () => {
		const order: string[] = [];
		const kernel = new ComponentKernel();

		kernel.register(component("tools:base", {
			onActivate: () => order.push("activate-old-tools"),
			onDispose: () => order.push("dispose-old-tools"),
		}));
		kernel.register({
			id: "prompt:base",
			kind: "prompt",
			dependencies: ["tools:base"],
			replaceable: true,
			activate: (context) => {
				order.push(`activate-prompt:${context.dependency<string>("tools:base").value}`);
				return {
					value: "prompt",
					dispose: () => {
						order.push("dispose-prompt");
					},
				};
			},
		});
		await kernel.activate("prompt:base");

		await kernel.replace("tools:base", {
			id: "tools:base",
			kind: "tools",
			replaceable: true,
			activate: () => {
				order.push("activate-new-tools");
				return {
					value: "new-tools",
					dispose: () => {
						order.push("dispose-new-tools");
					},
				};
			},
		});

		expect(order).toEqual([
			"activate-old-tools",
			"activate-prompt:tools:base",
			"activate-new-tools",
			"dispose-prompt",
			"dispose-old-tools",
			"activate-prompt:new-tools",
		]);
		expect(kernel.get("tools:base")?.value).toBe("new-tools");
		expect(kernel.get("prompt:base")?.status).toBe("active");
	});

	it("reactivates the disposed previous graph when dependent rebinding fails", async () => {
		const lifecycle: string[] = [];
		const kernel = new ComponentKernel();
		kernel.register({
			id: "tools:base",
			kind: "tools",
			replaceable: true,
			activate: () => ({ value: "old", dispose: () => { lifecycle.push("dispose-old"); } }),
		});
		kernel.register({
			id: "prompt:base",
			kind: "prompt",
			dependencies: ["tools:base"],
			replaceable: true,
			activate: (context) => {
				const tools = context.dependency<string>("tools:base").value;
				lifecycle.push(`activate-prompt:${tools}`);
				if (tools === "new") throw new Error("new tools are incompatible");
				return { value: "prompt", dispose: () => { lifecycle.push("dispose-prompt"); } };
			},
		});
		await kernel.activate("prompt:base");

		await expectComponentCode(
			() => kernel.replace("tools:base", {
				id: "tools:base",
				kind: "tools",
				replaceable: true,
				activate: () => ({ value: "new", dispose: () => { lifecycle.push("dispose-new"); } }),
			}),
			"COMPONENT_ACTIVATION_FAILED",
		);

		expect(kernel.get("tools:base")?.value).toBe("old");
		expect(kernel.get("prompt:base")?.value).toBe("prompt");
		expect(lifecycle).toEqual([
			"activate-prompt:old",
			"dispose-prompt",
			"dispose-old",
			"activate-prompt:new",
			"dispose-new",
			"activate-prompt:old",
		]);
	});

	it("records disposal failure and keeps dependent state visible", async () => {
		const kernel = new ComponentKernel();

		kernel.register(component("tools:base", {
			onDispose: () => {
				throw new Error("dispose failed");
			},
		}));
		kernel.register(component("prompt:base", { kind: "prompt", dependencies: ["tools:base"] }));
		await kernel.activate("prompt:base");

		await expectComponentCode(() => kernel.stop("tools:base"), "COMPONENT_DISPOSE_FAILED");

		expect(kernel.get("tools:base")?.status).toBe("active");
		expect(kernel.get("prompt:base")?.status).toBe("active");
		expect(kernel.snapshot().components.find((entry) => entry.id === "tools:base")?.lastReceipt).toEqual(
			expect.objectContaining({ code: "COMPONENT_DISPOSE_FAILED" }),
		);
	});

	it("returns immutable graph snapshots with status and receipt details", async () => {
		const kernel = new ComponentKernel();

		await kernel.activate(component("provider:default", { kind: "provider", replaceable: false }));
		const snapshot = kernel.snapshot();

		expect(Object.isFrozen(snapshot)).toBe(true);
		expect(Object.isFrozen(snapshot.components)).toBe(true);
		expect(Object.isFrozen(snapshot.components[0])).toBe(true);
		expect(Object.isFrozen(snapshot.components[0]?.dependencies)).toBe(true);
		expect(snapshot.components[0]).toEqual({
			id: "provider:default",
			kind: "provider",
			dependencies: [],
			replaceable: false,
			status: "active",
			lastReceipt: expect.objectContaining({
				code: "COMPONENT_ACTIVATED",
				status: "active",
			}),
		});

		expect(() => {
			(snapshot.components as unknown[]).push({});
		}).toThrow(TypeError);
	});
});
