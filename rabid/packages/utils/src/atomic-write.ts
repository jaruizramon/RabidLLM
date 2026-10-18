/**
 * Durable file publication: write a staged temp file, then rename it over the
 * target so a concurrent reader sees either the previous content or the whole
 * new content, never a partial write.
 */
import * as fs from "node:fs/promises";

/**
 * Publish `data` at `target` atomically. The caller owns the parent directory;
 * `Bun.write` creates it when missing, so a first write into a fresh directory
 * still lands.
 */
export async function writeFileAtomically(target: string, data: string | Uint8Array): Promise<void> {
	const temp = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
	try {
		await Bun.write(temp, data);
		await fs.rename(temp, target);
	} catch (error) {
		try {
			await fs.unlink(temp);
		} catch {
			// Never staged, or already renamed away.
		}
		throw error;
	}
}
