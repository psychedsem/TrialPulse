import argparse
import json

import chromadb
from chromadb.errors import NotFoundError

from build_index import load_model
from config import CHROMA_PATH, COLLECTION_NAME, QUERY_PREFIX, TOP_K


def retrieve(query, top_k=TOP_K, where=None, chroma_path=CHROMA_PATH):
    if not isinstance(query, str) or not query.strip():
        raise ValueError("La domanda deve essere un testo non vuoto.")
    if type(top_k) is not int or top_k < 1:
        raise ValueError("top_k deve essere un intero positivo.")

    with chromadb.PersistentClient(path=str(chroma_path)) as client:
        try:
            collection = client.get_collection(COLLECTION_NAME, embedding_function=None)
        except NotFoundError as error:
            raise ValueError("Indice RAG assente: eseguire prima rag/build_index.py.") from error

        embedding = load_model().encode(QUERY_PREFIX + query, normalize_embeddings=True)
        result = collection.query(
            query_embeddings=[embedding.tolist()], n_results=top_k, where=where,
            include=["documents", "metadatas", "distances"],
        )

    rows = zip(
        result["ids"][0], result["documents"][0],
        result["metadatas"][0], result["distances"][0],
    )
    return [{
        "id": record_id,
        "text": text,
        "source": metadata["source"],
        "section": metadata["section"],
        "metadata": metadata,
        "distance": float(distance),
        "rank": rank,
    } for rank, (record_id, text, metadata, distance) in enumerate(rows, 1)]


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Recupera chunk dalla KB locale, senza generare risposte.")
    parser.add_argument("query", help="Domanda da cercare nella KB")
    parser.add_argument("--top-k", type=int, default=TOP_K, help="Numero di risultati")
    parser.add_argument("--where", type=json.loads, help="Filtro metadata esplicito in JSON")
    args = parser.parse_args()
    print(json.dumps(retrieve(args.query, args.top_k, args.where),
                     ensure_ascii=False, indent=2))