from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.pipeline.rally_detector import MODEL_VERSION, build_rallies
from app.schemas import AnalyzeRequest, AnalyzeResponse

app = FastAPI(title="VolleyVision AI Worker", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
def health():
    return {"ok": True, "service": "volleyvision-ai-worker", "model_version": MODEL_VERSION}


@app.post("/analyze", response_model=AnalyzeResponse)
def analyze(req: AnalyzeRequest):
    rallies, message = build_rallies(
        match_id=req.match_id,
        video_url=req.video_url,
        duration_seconds=req.duration_seconds,
        first_serve_seconds=req.first_serve_seconds,
    )
    return AnalyzeResponse(
        status="complete",
        message=message,
        rallies=rallies,
        model_version=MODEL_VERSION,
    )
