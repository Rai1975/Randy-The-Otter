import os
import subprocess
import tempfile

from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel

app = FastAPI()

LATEX_SERVICE_TOKEN = os.environ.get("LATEX_SERVICE_TOKEN")

if not LATEX_SERVICE_TOKEN:
    raise RuntimeError("LATEX_SERVICE_TOKEN environment variable is required")


class CompileRequest(BaseModel):
    tex: str


@app.post("/compile")
def compile_tex(
    request: CompileRequest,
    authorization: str | None = Header(default=None),
):
    expected = f"Bearer {LATEX_SERVICE_TOKEN}"

    if authorization != expected:
        raise HTTPException(
            status_code=401,
            detail="Unauthorized",
        )

    with tempfile.TemporaryDirectory() as tmp:
        tex_path = os.path.join(tmp, "document.tex")

        with open(tex_path, "w", encoding="utf-8") as f:
            f.write(request.tex)

        result = subprocess.run(
            [
                "tectonic",
                "--outdir",
                tmp,
                tex_path,
            ],
            capture_output=True,
            text=True,
            timeout=60,
        )

        if result.returncode != 0:
            error_output = result.stderr or result.stdout
            raise HTTPException(
                status_code=500,
                detail=error_output[-5000:],
            )

        pdf_path = os.path.join(tmp, "document.pdf")

        if not os.path.exists(pdf_path):
            raise HTTPException(
                status_code=500,
                detail="Tectonic completed but no PDF was produced.",
            )

        with open(pdf_path, "rb") as f:
            pdf = f.read()

        return Response(
            content=pdf,
            media_type="application/pdf",
        )


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        app,
        host="0.0.0.0",
        port=int(os.environ.get("PORT", 8000)),
    )