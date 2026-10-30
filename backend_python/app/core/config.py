import os
import json
from typing import List

class Settings:
    PROJECT_NAME: str = os.getenv("PROJECT_NAME", "Smart Proctoring Browser API")
    VERSION: str = os.getenv("VERSION", "1.0.0")
    ENVIRONMENT: str = os.getenv("ENVIRONMENT", "development")
    PORT: int = int(os.getenv("PORT", "8000"))
    HOST: str = os.getenv("HOST", "0.0.0.0")
    
    _cors_raw = os.getenv("CORS_ORIGINS", "")
    if _cors_raw:
        try:
            CORS_ORIGINS: List[str] = json.loads(_cors_raw)
        except Exception:
            CORS_ORIGINS: List[str] = [x.strip() for x in _cors_raw.split(",") if x.strip()]
    else:
        CORS_ORIGINS: List[str] = [
            "https://clearview-room.lovable.app",
            "http://localhost:3000",
            "http://localhost:5173",
            "http://localhost:8000",
        ]
    
    JWT_SECRET_KEY: str = os.getenv("JWT_SECRET_KEY", "proctorshield_production_ready_secret_key_change_in_env")
    JWT_ALGORITHM: str = os.getenv("JWT_ALGORITHM", "HS256")
    JWT_ACCESS_TOKEN_EXPIRE_MINUTES: int = int(os.getenv("JWT_ACCESS_TOKEN_EXPIRE_MINUTES", "480"))
    
    DATABASE_URL: str = os.getenv("DATABASE_URL", "proctorshield_fastapi.db")

settings = Settings()
