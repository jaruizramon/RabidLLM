import { describe, expect, test } from "bun:test";
import { normalizeModelContextImages } from "@oh-my-pi/pi-coding-agent/utils/image-loading";
import { encodeRawPng } from "@oh-my-pi/pi-coding-agent/utils/png-encode";
import { ensureSupportedImageInput } from "@oh-my-pi/pi-tui/chat/image-loading";

// 1x1 red PNG (69 bytes). Bun.Image sniffs format from bytes, so we can pass
// this with a non-supported MIME type and the conversion path runs over the
// real native pipeline.
const RED_1X1_PNG_BASE64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC";

async function makeRedPng(width: number, height: number): Promise<string> {
	const seed = Buffer.from(RED_1X1_PNG_BASE64, "base64");
	const upscaled = await new Bun.Image(seed).resize(width, height, { filter: "nearest" }).png().bytes();
	return Buffer.from(upscaled).toBase64();
}

async function dimensions(image: { data: string }): Promise<{ width: number; height: number }> {
	const metadata = await new Bun.Image(Buffer.from(image.data, "base64")).metadata();
	return { width: metadata.width, height: metadata.height };
}

describe("ensureSupportedImageInput", () => {
	test("passes supported mime types through unchanged", async () => {
		const input = { type: "image" as const, data: RED_1X1_PNG_BASE64, mimeType: "image/png" };
		const result = await ensureSupportedImageInput(input);
		expect(result).toEqual(input);
	});

	test("converts unsupported image input to png", async () => {
		const result = await ensureSupportedImageInput({
			type: "image",
			data: RED_1X1_PNG_BASE64,
			mimeType: "image/bmp",
		});
		expect(result).not.toBeNull();
		expect(result?.mimeType).toBe("image/png");
		// PNG re-encode of a 1x1 image must yield a valid (non-empty) PNG signature
		// (`89 50 4E 47`) when decoded from base64.
		const bytes = Buffer.from(result!.data, "base64");
		expect(bytes.length).toBeGreaterThan(0);
		expect(bytes[0]).toBe(0x89);
		expect(bytes[1]).toBe(0x50);
		expect(bytes[2]).toBe(0x4e);
		expect(bytes[3]).toBe(0x47);
	});

	test("returns null when input bytes are not a decodable image", async () => {
		const result = await ensureSupportedImageInput({
			type: "image",
			data: Buffer.from("not an image").toString("base64"),
			mimeType: "image/bmp",
		});
		expect(result).toBeNull();
	});
});

describe("normalizeModelContextImages", () => {
	test("re-encodes a high-entropy image into a materially lighter block", async () => {
		const size = 512;
		const pixels = new Uint8Array(size * size * 4);
		for (let y = 0; y < size; y++) {
			for (let x = 0; x < size; x++) {
				const i = (y * size + x) * 4;
				pixels[i] = (x * 37 + y * 91 + x * y) & 255;
				pixels[i + 1] = (x * 53 + y * 29 + x * y * 3) & 255;
				pixels[i + 2] = (x * 11 + y * 71 + x * y * 7) & 255;
				pixels[i + 3] = 255;
			}
		}
		const source = encodeRawPng(pixels, size, size, 4, 6);
		const result = await normalizeModelContextImages([
			{ type: "image", data: Buffer.from(source).toBase64(), mimeType: "image/png" },
		]);
		const output = Buffer.from(result![0]!.data, "base64");
		expect(result?.[0]?.mimeType).not.toBe("image/webp");
		expect(output.length).toBeLessThan(source.length);
	});

	test("downscales multiple large images before model context", async () => {
		const wide = { type: "image" as const, data: await makeRedPng(2000, 1500), mimeType: "image/png" };
		const tall = { type: "image" as const, data: await makeRedPng(1200, 2200), mimeType: "image/png" };

		const result = await normalizeModelContextImages([wide, tall]);

		expect(result).toHaveLength(2);
		expect(result?.[0]?.type).toBe("image");
		expect(result?.[1]?.type).toBe("image");
		const wideDims = await dimensions(result![0]!);
		const tallDims = await dimensions(result![1]!);
		expect(wideDims.width).toBeLessThanOrEqual(640);
		expect(wideDims.height).toBeLessThanOrEqual(640);
		expect(tallDims.width).toBeLessThanOrEqual(640);
		expect(tallDims.height).toBeLessThanOrEqual(640);
	});
});
