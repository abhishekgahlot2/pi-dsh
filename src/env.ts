import { link, open, truncate } from "node:fs/promises";

// Filesystem durability exposes the sync primitives required by acknowledged appends.
import { NodeExecutionEnv } from "../vendor/pi/harness/env/nodejs.ts";
import {
	err,
	ExecutionError,
	FileError,
	ok,
	type Result,
	type ShellExecOptions,
	toError,
} from "../vendor/pi/harness/types.ts";
import type { JsonlSessionRepoFileSystem } from "../vendor/pi/harness/session/jsonl.ts";

export interface DurableJsonlFileSystem extends JsonlSessionRepoFileSystem {
	syncFile(path: string): Promise<Result<void, FileError>>;
	syncDir(path: string): Promise<Result<void, FileError>>;
	truncateFile(path: string, size: number): Promise<Result<void, FileError>>;
	linkFile(sourcePath: string, destinationPath: string): Promise<Result<void, FileError>>;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error;
}

function toFileError(error: unknown, fallbackPath?: string): FileError {
	if (error instanceof FileError) return error;
	const cause = toError(error);
	const nodeError = isNodeError(error) ? error : undefined;
	const path = typeof nodeError?.path === "string" ? nodeError.path : fallbackPath;
	if (nodeError) {
		switch (nodeError.code) {
			case "ENOENT":
				return new FileError("not_found", nodeError.message, path, cause);
			case "EACCES":
			case "EPERM":
				return new FileError("permission_denied", nodeError.message, path, cause);
			case "ENOTDIR":
				return new FileError("not_directory", nodeError.message, path, cause);
			case "EISDIR":
				return new FileError("is_directory", nodeError.message, path, cause);
			case "EEXIST":
			case "EINVAL":
				return new FileError("invalid", nodeError.message, path, cause);
		}
	}
	return new FileError("unknown", cause.message, path, cause);
}

async function syncOpenPath(path: string, flags: string): Promise<Result<void, FileError>> {
	let handle: Awaited<ReturnType<typeof open>> | undefined;
	try {
		handle = await open(path, flags);
		await handle.sync();
		return ok(undefined);
	} catch (error) {
		return err(toFileError(error, path));
	} finally {
		await handle?.close().catch(() => undefined);
	}
}

export class NodeDurableExecutionEnv extends NodeExecutionEnv implements DurableJsonlFileSystem {
	override exec(
		command: string,
		options: ShellExecOptions = {},
	): Promise<Result<{ stdout: string; stderr: string; exitCode: number }, ExecutionError>> {
		const timeout = options.timeout ?? 120;
		if (timeout > 600) {
			return Promise.resolve(err(new ExecutionError("timeout", "Invalid timeout: maximum is 600 seconds")));
		}
		return super.exec(command, { ...options, timeout });
	}

	async syncFile(path: string): Promise<Result<void, FileError>> {
		return syncOpenPath(path, "r+");
	}

	async syncDir(path: string): Promise<Result<void, FileError>> {
		return syncOpenPath(path, "r");
	}

	async truncateFile(path: string, size: number): Promise<Result<void, FileError>> {
		try {
			await truncate(path, size);
			return ok(undefined);
		} catch (error) {
			return err(toFileError(error, path));
		}
	}

	async linkFile(sourcePath: string, destinationPath: string): Promise<Result<void, FileError>> {
		try {
			await link(sourcePath, destinationPath);
			return ok(undefined);
		} catch (error) {
			return err(toFileError(error, destinationPath));
		}
	}
}
