from __future__ import annotations

import argparse
import json
import shutil
import subprocess
from datetime import datetime
from pathlib import Path


ROOT = Path(__file__).resolve().parent


def copy_file(source: Path, target: Path) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, target)


def copy_tree_files(source: Path, target: Path, names: list[str]) -> None:
    target.mkdir(parents=True, exist_ok=True)
    for name in names:
        copy_file(source / name, target / name)


def require_version(plugin_dir: Path, version: str) -> None:
    manifest = plugin_dir / "manifest.json"
    if not manifest.exists():
        raise RuntimeError(f"플러그인을 먼저 설치하세요: {plugin_dir.name} {version}")
    installed = json.loads(manifest.read_text()).get("version")
    if installed != version:
        raise RuntimeError(f"{plugin_dir.name}: {version} 필요, 현재 {installed}")


def main() -> None:
    parser = argparse.ArgumentParser(description="Install the tracked Obsidian configuration into a vault.")
    parser.add_argument("vault", type=Path, help="Obsidian vault directory")
    args = parser.parse_args()
    vault = args.vault.expanduser().resolve()
    obsidian = vault / ".obsidian"
    if not obsidian.is_dir():
        raise SystemExit(f"Obsidian 보관함이 아닙니다: {vault}")

    backup = vault.parent / f"{vault.name}-obsidian-config-backup-{datetime.now():%Y%m%d-%H%M%S}"
    backup.mkdir(parents=True)
    targets = [
        obsidian / name
        for name in ["app.json", "appearance.json", "community-plugins.json", "core-plugins.json", "hotkeys.json"]
    ]
    targets += [
        obsidian / "snippets" / "readable-lists.css",
        obsidian / "snippets" / "readable-tables.css",
        obsidian / "plugins" / "obsidian-spaced-repetition",
        obsidian / "plugins" / "obsidian-paste-to-current-indentation",
        obsidian / "plugins" / "notebook-navigator",
        obsidian / "plugins" / "list-marker-input",
        obsidian / "plugins" / "navigator-vim-keys",
        obsidian / "plugins" / "vim-im-control",
    ]
    for target in targets:
        if not target.exists():
            continue
        relative = target.relative_to(obsidian)
        destination = backup / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        if target.is_dir():
            shutil.copytree(target, destination)
        else:
            shutil.copy2(target, destination)

    config = ROOT / "config"
    for name in ["app.json", "appearance.json", "community-plugins.json", "core-plugins.json", "hotkeys.json"]:
        copy_file(config / name, obsidian / name)
    copy_tree_files(config / "snippets", obsidian / "snippets", ["readable-lists.css", "readable-tables.css"])

    plugin_root = obsidian / "plugins"
    settings = {
        "notebook-navigator": "notebook-navigator.json",
        "obsidian-paste-to-current-indentation": "paste-mode.json",
        "obsidian-spaced-repetition": "spaced-repetition.json",
        "obsidian-style-settings": "style-settings.json",
    }
    for plugin_id, source_name in settings.items():
        target = plugin_root / plugin_id
        if target.is_dir():
            copy_file(config / "plugin-settings" / source_name, target / "data.json")

    require_version(plugin_root / "obsidian-spaced-repetition", "1.15.4")
    require_version(plugin_root / "obsidian-paste-to-current-indentation", "5.0.2")
    require_version(plugin_root / "notebook-navigator", "3.2.2")

    subprocess.run([
        "python3", str(ROOT / "plugins/spaced-repetition-anki/build.py"),
        "--base", str(plugin_root / "obsidian-spaced-repetition/main.js"),
        "--output", str(plugin_root / "obsidian-spaced-repetition"),
    ], check=True)
    subprocess.run([
        "python3", str(ROOT / "plugins/paste-mode-tables/build.py"),
        "--base", str(plugin_root / "obsidian-paste-to-current-indentation/main.js"),
        "--output", str(plugin_root / "obsidian-paste-to-current-indentation"),
    ], check=True)
    subprocess.run([
        "python3", str(ROOT / "plugins/navigator-vim-keys/build.py"),
        "--base", str(plugin_root / "notebook-navigator/main.js"),
        "--output", str(plugin_root / "notebook-navigator/main.js"),
    ], check=True)

    copy_tree_files(
        ROOT / "plugins/list-marker-input",
        plugin_root / "list-marker-input",
        ["main.js", "manifest.json"],
    )
    copy_tree_files(
        ROOT / "plugins/navigator-vim-keys",
        plugin_root / "navigator-vim-keys",
        ["main.js", "manifest.json", "styles.css"],
    )
    vim_target = plugin_root / "vim-im-control"
    copy_tree_files(
        ROOT / "plugins/vim-im-control",
        vim_target,
        ["main.js", "manifest.json", "LICENSE", "im-select-LICENSE", "im-select.m"],
    )
    try:
        subprocess.run([
            "clang", "-framework", "Carbon", "-framework", "Foundation",
            "-o", str(vim_target / "im-select"), str(vim_target / "im-select.m"),
        ], check=True)
        selector = vim_target / "im-select"
        selector.chmod(0o755)
        command = f"'{selector}'"
        vim_data = {
            "macos": {
                "pathToIMControl": str(vim_target),
                "cmdOnInsertLeave": f"{command} com.apple.keylayout.ABC",
                "cmdOnInsertEnter": f"{command} {{{{im}}}}",
                "cmdGetCurrentIM": command,
            },
            "isAsync": False,
            "isStatusBarEnabled": True,
        }
        (vim_target / "data.json").write_text(json.dumps(vim_data, ensure_ascii=False, indent=2) + "\n")
    except (FileNotFoundError, subprocess.CalledProcessError):
        print("clang을 사용할 수 없어 im-select 빌드는 건너뛰었습니다.")

    print(f"설치 완료: {vault}")
    print(f"백업: {backup}")


if __name__ == "__main__":
    main()

