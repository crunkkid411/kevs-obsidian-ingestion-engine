#!/usr/bin/env python3
"""
Text embeddings with Qwen3-Embedding (sentence-transformers).

Contract (stdout JSON): { "model","dim","vectors":[[float,...], ...] }

Install: pip install -U sentence-transformers
Default model dim: Qwen3-Embedding-0.6B = 1024 (must match schema vector(N)).
Models are cached to models/embeddings/ (via SENTENCE_TRANSFORMERS_HOME).

Usage: python embed_text.py --texts-b64 <base64 json array> [--model ...]
"""
import argparse, base64, json, os, sys

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_CACHE_DIR = os.path.join(REPO_ROOT, "models", "embeddings")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--texts-b64", required=True)
    ap.add_argument("--model", default=os.environ.get("TEXT_EMBED_MODEL", "Qwen/Qwen3-Embedding-0.6B"))
    ap.add_argument("--cache-dir", default=DEFAULT_CACHE_DIR)
    args = ap.parse_args()

    # Point sentence-transformers cache to models/embeddings/
    os.makedirs(args.cache_dir, exist_ok=True)
    os.environ.setdefault("SENTENCE_TRANSFORMERS_HOME", args.cache_dir)
    os.environ.setdefault("HF_HOME", args.cache_dir)

    texts = json.loads(base64.b64decode(args.texts_b64))
    from sentence_transformers import SentenceTransformer
    model = SentenceTransformer(args.model, cache_folder=args.cache_dir)
    # Qwen3-Embedding recommends normalized embeddings for cosine search.
    vecs = model.encode(texts, normalize_embeddings=True, convert_to_numpy=True)

    print(json.dumps({
        "model": args.model,
        "dim": int(vecs.shape[1]) if len(vecs) else 0,
        "vectors": [[round(float(x), 6) for x in v] for v in vecs],
    }))


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(json.dumps({"skipped": True, "reason": f"{type(e).__name__}: {e}"}))
        sys.exit(0)
