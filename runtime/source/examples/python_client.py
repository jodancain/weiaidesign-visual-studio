import os
import time
from typing import Any

import requests


BASE_URL = os.getenv("VIDEO_API_BASE_URL", "https://video.youngtuo.win/api/v1")
TOKEN = os.environ["VIDEO_API_TOKEN"]


def video_api(path: str, method: str = "GET", json: dict[str, Any] | None = None) -> dict[str, Any]:
    response = requests.request(
        method,
        f"{BASE_URL}{path}",
        headers={"Authorization": f"Bearer {TOKEN}"},
        json=json,
        timeout=120,
    )
    response.raise_for_status()
    return response.json()


def create_video(subject: str) -> dict[str, Any]:
    return video_api(
        "/videos",
        method="POST",
        json={
            "video_subject": subject,
            "video_language": "zh-CN",
            "video_aspect": "9:16",
            "video_count": 1,
            "video_clip_duration": 5,
            "voice_name": "zh-CN-XiaoxiaoNeural-Female",
            "subtitle_enabled": True,
            "paragraph_number": 1,
        },
    )


def get_video(task_id: str) -> dict[str, Any]:
    return video_api(f"/videos/{task_id}")


def wait_for_video(task_id: str, interval_seconds: int = 5) -> dict[str, Any]:
    while True:
        status = get_video(task_id)
        data = status.get("data") or status
        if data.get("state") in (1, -1):
            return status
        time.sleep(interval_seconds)


if __name__ == "__main__":
    created = create_video(os.getenv("VIDEO_SUBJECT", "海边日出与效率工具"))
    task_id = (created.get("data") or created).get("task_id")
    print("task_id:", task_id)
    print(wait_for_video(task_id))
