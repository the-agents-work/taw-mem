// Lazy-loaded local embedding via @xenova/transformers.
// Model: Xenova/all-MiniLM-L6-v2 (384-dim, ~23MB ONNX, CPU).
// First call downloads to ~/.cache/huggingface — subsequent calls fast.

let _extractor: Promise<any> | null = null;

async function getExtractor(): Promise<any> {
  if (_extractor) return _extractor;

  _extractor = (async () => {
    // dynamic import keeps server startup fast
    const tf = await import("@xenova/transformers");
    // suppress noisy progress to stderr only on first download
    (tf as any).env.allowLocalModels = false;
    process.stderr.write("[taw-mem] loading embedding model (first run downloads ~23MB)...\n");
    const pipe = await tf.pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2");
    process.stderr.write("[taw-mem] embedding model ready\n");
    return pipe;
  })();

  return _extractor;
}

export async function embed(text: string): Promise<number[]> {
  const extractor = await getExtractor();
  const out = await extractor(text, { pooling: "mean", normalize: true });
  return Array.from(out.data as Float32Array);
}

export const EMBED_DIM = 384;
