from fastapi import APIRouter
from app.schemas.all_schemas import StandardResponse
from app.core.config import settings

router = APIRouter(tags=["Health & Status"])

@router.get("/health", response_model=StandardResponse, summary="API Health Check")
def health_check():
    return StandardResponse(
        message="Service is running healthy",
        data={
            "status": "healthy",
            "project": settings.PROJECT_NAME,
            "version": settings.VERSION,
            "environment": settings.ENVIRONMENT
        }
    )

