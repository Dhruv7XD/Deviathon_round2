from fastapi import Depends
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from app.core.exceptions import UnauthorizedException, ForbiddenException
from app.core.security import decode_access_token

security_scheme = HTTPBearer(auto_error=False)

def get_current_user(credentials: HTTPAuthorizationCredentials = Depends(security_scheme)) -> dict:
    if not credentials or not credentials.credentials:
        raise UnauthorizedException("Authorization header with Bearer token is required")
    
    payload = decode_access_token(credentials.credentials)
    if not payload:
        raise UnauthorizedException("Token is invalid or expired")
    
    return {
        "id": payload.get("sub"),
        "email": payload.get("email"),
        "role": payload.get("role", "candidate"),
        "name": payload.get("name", "")
    }

def require_role(*allowed_roles: str):
    def role_checker(current_user: dict = Depends(get_current_user)) -> dict:
        if current_user.get("role") not in allowed_roles:
            raise ForbiddenException(f"Action requires one of roles: {', '.join(allowed_roles)}")
        return current_user
    return role_checker

