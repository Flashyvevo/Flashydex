"""Pydantic models = the public ``POST /v1/identify`` contract (mirrored in packages/schemas/src/recognition.ts)."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

Status = Literal["match", "candidates", "no_card", "no_match"]


class Signals(BaseModel):
    hash: float | None = None
    embed: float | None = None
    ocr: float | None = None
    symbol: float | None = None


class VariantHints(BaseModel):
    reverseHolo: float | None = Field(default=None, ge=0, le=1)
    firstEdition: float | None = Field(default=None, ge=0, le=1)
    stamp: float | None = Field(default=None, ge=0, le=1)


class Candidate(BaseModel):
    language: Literal["en", "ja"]
    cardId: str
    localId: str
    name: str
    setId: str
    setName: str
    imageUrl: str | None
    score: float = Field(ge=0, le=1)
    signals: Signals
    variantHints: VariantHints


class Detection(BaseModel):
    quadFound: bool
    fallback: Literal["none", "centre"]


class OcrRead(BaseModel):
    number: int | None
    total: int | None
    setCode: str | None
    confidence: float


class IdentifyResponse(BaseModel):
    status: Status
    confidence: float = Field(ge=0, le=1)
    candidates: list[Candidate]
    timingMs: dict[str, float]
    indexVersion: str
    detection: Detection | None = None
    ocr: OcrRead | None = None
