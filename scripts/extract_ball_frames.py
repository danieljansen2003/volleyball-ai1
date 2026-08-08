from pathlib import Path

import cv2


PROJECT_ROOT = Path(__file__).resolve().parent.parent

VIDEO_FOLDER = (
    PROJECT_ROOT
    / "datasets"
    / "volleyball-ball"
    / "raw-videos"
)

OUTPUT_FOLDER = (
    PROJECT_ROOT
    / "datasets"
    / "volleyball-ball"
    / "frames"
)

# Save around 5 frames per second.
FRAMES_PER_SECOND_TO_SAVE = 5


def extract_video(video_path: Path) -> None:
    capture = cv2.VideoCapture(str(video_path))

    if not capture.isOpened():
        print(f"Could not open: {video_path}")
        return

    fps = float(capture.get(cv2.CAP_PROP_FPS) or 30.0)

    frame_interval = max(
        1,
        int(round(fps / FRAMES_PER_SECOND_TO_SAVE)),
    )

    video_output = OUTPUT_FOLDER / video_path.stem
    video_output.mkdir(parents=True, exist_ok=True)

    frame_number = 0
    saved_number = 0

    while True:
        success, frame = capture.read()

        if not success:
            break

        if frame_number % frame_interval == 0:
            output_path = (
                video_output
                / f"{video_path.stem}_{saved_number:06d}.jpg"
            )

            cv2.imwrite(
                str(output_path),
                frame,
                [cv2.IMWRITE_JPEG_QUALITY, 95],
            )

            saved_number += 1

        frame_number += 1

    capture.release()

    print(
        f"{video_path.name}: saved "
        f"{saved_number} frames"
    )


def main() -> None:
    OUTPUT_FOLDER.mkdir(
        parents=True,
        exist_ok=True,
    )

    videos = []

    for extension in (
        "*.mov",
        "*.mp4",
        "*.m4v",
        "*.MOV",
        "*.MP4",
    ):
        videos.extend(
            VIDEO_FOLDER.glob(extension)
        )

    if not videos:
        print(
            f"No videos found in {VIDEO_FOLDER}"
        )
        return

    for video in sorted(videos):
        extract_video(video)

    print("Done.")


if __name__ == "__main__":
    main()