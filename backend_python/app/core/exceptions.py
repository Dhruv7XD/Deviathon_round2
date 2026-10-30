from fastapi import HTTPException, status

class AppException(HTTPException):
    def __init__(self, status_code: int, message: str, error_code: str = "APP_ERROR"):
        super().__init__(status_code=status_code, detail={"error_code": error_code, "message": message})

class NotFoundException(AppException):
    def __init__(self, message: str = "Resource not found"):
        super().__init__(status_code=status.HTTP_404_NOT_FOUND, message=message, error_code="NOT_FOUND")

class UnauthorizedException(AppException):
    def __init__(self, message: str = "Invalid credentials or token expired"):
        super().__init__(status_code=status.HTTP_401_UNAUTHORIZED, message=message, error_code="UNAUTHORIZED")

class ForbiddenException(AppException):
    def __init__(self, message: str = "Insufficient permissions"):
        super().__init__(status_code=status.HTTP_403_FORBIDDEN, message=message, error_code="FORBIDDEN")

class BadRequestException(AppException):
    def __init__(self, message: str = "Bad request"):
        super().__init__(status_code=status.HTTP_400_BAD_REQUEST, message=message, error_code="BAD_REQUEST")

