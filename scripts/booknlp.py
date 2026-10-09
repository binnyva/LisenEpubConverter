#!/usr/bin/env python3
"""Repository-owned, non-installing BookNLP adapter."""

from __future__ import annotations

import argparse
import importlib.metadata
import json
from pathlib import Path
import sys

# This file is intentionally named booknlp.py, matching the documented Lisen
# command. Remove its directory from module lookup so it cannot shadow the
# installed `booknlp` package.
SCRIPT_DIRECTORY = Path(__file__).resolve().parent
sys.path = [entry for entry in sys.path if Path(entry or ".").resolve() != SCRIPT_DIRECTORY]


MODEL_FILES = {
    "small": [
        "entities_google_bert_uncased_L-4_H-256_A-4-v1.0.model",
        "coref_google_bert_uncased_L-2_H-256_A-4-v1.0.model",
        "speaker_google_bert_uncased_L-8_H-256_A-4-v1.0.1.model",
    ],
    "big": [
        "entities_google_bert_uncased_L-6_H-768_A-12-v1.0.model",
        "coref_google_bert_uncased_L-12_H-768_A-12-v1.0.model",
        "speaker_google_bert_uncased_L-12_H-768_A-12-v1.0.1.model",
    ],
}


def preflight(model: str, model_path: Path) -> dict[str, str]:
    booknlp_version = importlib.metadata.version("booknlp")
    transformers_version = importlib.metadata.version("transformers")
    try:
        from booknlp.booknlp import BookNLP  # noqa: F401
        import spacy
    except Exception as exc:
        raise RuntimeError(f"BookNLP imports failed: {exc}") from exc
    if not spacy.util.is_package("en_core_web_sm"):
        raise RuntimeError("spaCy model en_core_web_sm is missing from the BookNLP environment")
    missing = [name for name in MODEL_FILES[model] if not (model_path / name).is_file()]
    if missing:
        raise RuntimeError(
            f"BookNLP {model} model files are missing from {model_path}: {', '.join(missing)}. "
            "Install them explicitly before running Lisen; automatic downloads are disabled."
        )
    return {
        "toolVersion": booknlp_version,
        "transformersVersion": transformers_version,
        "spacyVersion": importlib.metadata.version("spacy"),
        "model": model,
        "modelPath": str(model_path),
    }


def install_position_id_compatibility() -> None:
    """Ignore obsolete BERT position-id buffers in BookNLP's saved weights.

    BookNLP 1.0.8 model files contain ``*.embeddings.position_ids`` values,
    while newer Transformers releases derive those values instead of keeping
    them in the model state. Upstream BookNLP fixes remove these keys before
    loading. Apply the same narrow, process-local transformation here without
    modifying the Conda environment or the paid/downloaded model files.
    """
    import torch

    original = torch.nn.Module.load_state_dict

    def compatible_load_state_dict(module, state_dict, *args, **kwargs):
        obsolete = [key for key in state_dict if key.endswith(".embeddings.position_ids")]
        if obsolete:
            state_dict = state_dict.copy()
            for key in obsolete:
                del state_dict[key]
        return original(module, state_dict, *args, **kwargs)

    torch.nn.Module.load_state_dict = compatible_load_state_dict


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("input", nargs="?")
    parser.add_argument("--output-dir")
    parser.add_argument("--book-id", default="book")
    parser.add_argument("--model", choices=("big", "small"), default="big")
    parser.add_argument("--model-path", default=str(Path.home() / "booknlp_models"))
    parser.add_argument("--check-only", action="store_true")
    args = parser.parse_args()

    try:
        details = preflight(args.model, Path(args.model_path))
        if args.check_only:
            print(json.dumps(details))
            return 0
        if not args.input or not args.output_dir:
            parser.error("input and --output-dir are required unless --check-only is used")
        source = Path(args.input)
        if not source.is_file():
            raise RuntimeError(f"annotation input does not exist: {source}")
        output = Path(args.output_dir)
        output.mkdir(parents=True, exist_ok=False)
        install_position_id_compatibility()
        from booknlp.booknlp import BookNLP

        pipeline = "entity,quote,coref"
        processor = BookNLP("en", {
            "pipeline": pipeline,
            "model": args.model,
            "model_path": str(Path(args.model_path)),
        })
        processor.process(str(source), str(output), args.book_id)
        (output / "run.json").write_text(json.dumps({**details, "pipeline": pipeline}, indent=2), encoding="utf-8")
        print(json.dumps({**details, "pipeline": pipeline, "outputDir": str(output)}))
        return 0
    except Exception as exc:
        print(f"BookNLP adapter error: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
