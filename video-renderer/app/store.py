from app.models import JobState

# In-memory job store. Fine for a single-process hackathon deploy; jobs are
# lost on restart, which doesn't matter since the whole pipeline is re-run
# per request from the frontend anyway.
_jobs: dict[str, JobState] = {}


def create(job: JobState) -> None:
    _jobs[job.job_id] = job


def get(job_id: str) -> JobState | None:
    return _jobs.get(job_id)


def save(job: JobState) -> None:
    _jobs[job.job_id] = job
