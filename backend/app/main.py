import asyncio
from contextlib import asynccontextmanager, suppress

from fastapi import FastAPI
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from starlette.exceptions import HTTPException

from app.api import router
from app.config import Settings
from app.errors import (
    AppError,
    app_error_handler,
    http_error_handler,
    validation_error_handler,
)
from app.repository import Repository
from app.services.demo import DemoService
from app.services.workflow import Workflow
from app.services.workspaces import WorkspaceStore
from app.workspace_api import router as workspace_router
from app.mis_api import router as mis_router
from app.live_api import router as live_router


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or Settings()
    repository = Repository(settings.data_dir / "medhub.sqlite3")
    workspaces = WorkspaceStore(settings.workspace_ttl_seconds, settings.database_url if settings.persist_workspaces else "")

    async def cleanup():
        while True:
            await asyncio.sleep(30)
            workspaces.purge()

    @asynccontextmanager
    async def lifespan(application: FastAPI):
        repository.initialize()
        repository.recover_interrupted_jobs()
        workspaces.initialize()
        cleaner = asyncio.create_task(cleanup())
        try:
            yield
        finally:
            cleaner.cancel()
            with suppress(asyncio.CancelledError):
                await cleaner
            workspaces.items.clear()

    application = FastAPI(
        title="MedHub consultation API",
        version="0.1.0",
        description=(
            "Скелет backend для Haqaton-042. Только синтетические данные: "
            "авторизация и реальные AI/МИС-интеграции ещё не реализованы. "
            "Все JSON-поля используют snake_case."
        ),
        lifespan=lifespan,
    )
    application.state.settings = settings
    application.state.repository = repository
    application.state.workflow = Workflow(repository)
    application.state.demo = DemoService(repository)
    application.state.workspaces = workspaces
    application.add_exception_handler(AppError, app_error_handler)
    application.add_exception_handler(RequestValidationError, validation_error_handler)
    application.add_exception_handler(HTTPException, http_error_handler)
    application.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_methods=["GET", "POST", "PATCH", "DELETE"],
        allow_headers=["Content-Type"],
        allow_credentials=False,
    )
    application.include_router(router)
    application.include_router(workspace_router)
    application.include_router(mis_router)
    application.include_router(live_router)

    @application.middleware("http")
    async def prevent_clinical_cache(request, call_next):
        response = await call_next(request)
        if request.url.path.startswith(("/api/workspaces", "/api/integrations")):
            response.headers["Cache-Control"] = "no-store"
        return response

    return application


app = create_app()
