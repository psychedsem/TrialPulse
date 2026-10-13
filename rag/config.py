from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parent.parent
MANIFEST_PATH = PROJECT_ROOT / "knowledge_base" / "manifest.yaml"
CHROMA_PATH = Path(__file__).resolve().parent / "chroma_db"

COLLECTION_NAME = "trialpulse_kb"
EMBEDDING_MODEL = "intfloat/multilingual-e5-small"

QUERY_PREFIX = "query: "
PASSAGE_PREFIX = "passage: "

TOP_K = 4
TARGET_TOKENS = 350
MAX_TOKENS = 450
OVERLAP_TOKENS = 50