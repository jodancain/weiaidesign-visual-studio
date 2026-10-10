const BASE_URL = process.env.VIDEO_API_BASE_URL || "https://video.youngtuo.win/api/v1";
const TOKEN = process.env.VIDEO_API_TOKEN;

if (!TOKEN) {
  throw new Error("Set VIDEO_API_TOKEN first.");
}

async function videoApi(path, options = {}) {
  const response = await fetch(`${BASE_URL}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });

  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}: ${text}`);
  }
  return data;
}

export async function createVideo(subject) {
  return videoApi("/videos", {
    method: "POST",
    body: JSON.stringify({
      video_subject: subject,
      video_language: "zh-CN",
      video_aspect: "9:16",
      video_count: 1,
      video_clip_duration: 5,
      voice_name: "zh-CN-XiaoxiaoNeural-Female",
      subtitle_enabled: true,
      paragraph_number: 1,
    }),
  });
}

export async function getVideo(taskId) {
  return videoApi(`/videos/${taskId}`, { method: "GET" });
}

export async function waitForVideo(taskId, intervalMs = 5000) {
  for (;;) {
    const status = await getVideo(taskId);
    const data = status.data || status;
    if (data.state === 1 || data.state === -1) return status;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const subject = process.argv.slice(2).join(" ") || "海边日出与效率工具";
  const created = await createVideo(subject);
  const taskId = created.data?.task_id || created.task_id;
  console.log("task_id:", taskId);
  const finalStatus = await waitForVideo(taskId);
  console.log(JSON.stringify(finalStatus, null, 2));
}
