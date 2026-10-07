from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, ConfigDict, Field

from config import TOP_K
from retriever import retrieve


class RetrieveRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, str_strip_whitespace=True)

    query: str = Field(min_length=1)
    top_k: int = Field(default=TOP_K, gt=0)
    where: dict | None = None


app = FastAPI(title="TrialPulse RAG")


@app.get("/health")
def health():
    return {"status": "ok", "service": "trialpulse-rag"}


@app.post("/retrieve")
def retrieve_documents(request: RetrieveRequest):
    try:
        return {"results": retrieve(request.query, top_k=request.top_k, where=request.where)}
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    except Exception as exc:
        raise HTTPException(503, "Servizio documentale non disponibile.") from exc
