from functools import lru_cache

import chromadb
from sentence_transformers import SentenceTransformer

from config import CHROMA_PATH, COLLECTION_NAME, EMBEDDING_MODEL, PASSAGE_PREFIX
from documents import build_chunks


@lru_cache(maxsize=1)
def load_model():
    return SentenceTransformer(EMBEDDING_MODEL, device="cpu")


def build_index(chroma_path=CHROMA_PATH):
    model = load_model()
    chunks = build_chunks(model.tokenizer)
    embeddings = model.encode(
        [PASSAGE_PREFIX + chunk["text"] for chunk in chunks],
        normalize_embeddings=True,
    )

    with chromadb.PersistentClient(path=str(chroma_path)) as client:
        if COLLECTION_NAME in {item.name for item in client.list_collections()}:
            client.delete_collection(COLLECTION_NAME)
        collection = client.create_collection(
            COLLECTION_NAME,
            embedding_function=None,
            configuration={"hnsw": {"space": "cosine"}},
        )
        collection.add(
            ids=[chunk["id"] for chunk in chunks],
            embeddings=embeddings.tolist(),
            documents=[chunk["text"] for chunk in chunks],
            metadatas=[chunk["metadata"] for chunk in chunks],
        )
        count = collection.count()
        if count != len(chunks):
            raise RuntimeError("Conteggio indice diverso dal numero di chunk prodotti.")

    return {
        "collection": COLLECTION_NAME,
        "chunks": count,
        "sources": len({chunk["metadata"]["source"] for chunk in chunks}),
        "embedding_dimension": embeddings.shape[1],
        "path": str(chroma_path),
    }


if __name__ == "__main__":
    result = build_index()
    print(f"Indice {result['collection']}: {result['chunks']} chunk, "
          f"{result['sources']} documenti, embedding {result['embedding_dimension']}D.")
    print(f"Persistenza: {result['path']}")
