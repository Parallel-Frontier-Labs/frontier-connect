"""The Microsoft Copilot (Cowork) package: layout, manifest, icons, tools and determinism."""
from __future__ import annotations

import importlib.util
import json
import re
import struct
import tempfile
import unittest
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
_spec = importlib.util.spec_from_file_location("build_copilot", ROOT / "scripts" / "build_copilot.py")
build_copilot = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(build_copilot)

SKILL_TOOLS = ["frontier_start_task", "frontier_continue_task", "frontier_add_files", "frontier_request_upload",
               "frontier_wait_task", "frontier_get_task", "frontier_answer", "frontier_steer", "frontier_stop_task",
               "frontier_request_download", "frontier_list_tasks", "frontier_list_playbooks"]


def png_size(data: bytes) -> tuple[int, int]:
    assert data[:8] == b"\x89PNG\r\n\x1a\n"
    return struct.unpack(">II", data[16:24])


class CopilotPackage(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.zip_path = build_copilot.build(Path(cls.tmp.name) / "frontier-copilot.zip")
        cls.zip = zipfile.ZipFile(cls.zip_path)
        cls.names = cls.zip.namelist()
        cls.manifest = json.loads(cls.zip.read("manifest.json"))

    @classmethod
    def tearDownClass(cls):
        cls.zip.close()
        cls.tmp.cleanup()

    def test_everything_sits_at_the_root_with_no_wrapper_folder(self):
        self.assertIn("manifest.json", self.names)
        self.assertEqual({n.split("/")[0] for n in self.names},
                         {"manifest.json", "color.png", "outline.png", "tools", "skills"})
        self.assertIn("skills/frontier/SKILL.md", self.names)
        self.assertIn("skills/frontier/scripts/frontier.py", self.names)
        self.assertFalse([n for n in self.names if "__pycache__" in n or n.endswith(".pyc")])

    def test_manifest_essentials(self):
        m = self.manifest
        self.assertEqual(m["manifestVersion"], "1.28")
        self.assertIn("/v1.28/", m["$schema"])
        self.assertRegex(m["id"], r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
        plugin = json.loads((ROOT / "plugin" / ".claude-plugin" / "plugin.json").read_text())
        self.assertEqual(m["version"], plugin["version"])
        self.assertLessEqual(len(m["name"]["short"]), 30)
        self.assertLessEqual(len(m["description"]["short"]), 80)
        self.assertLessEqual(len(m["developer"]["name"]), 32)
        for path in (m["icons"]["color"], m["icons"]["outline"]):
            self.assertIn(path, self.names)
        for skill in m["agentSkills"]:
            folder = skill["folder"].removeprefix("./")
            self.assertIn(f"{folder}/SKILL.md", self.names)
            head = self.zip.read(f"{folder}/SKILL.md").decode()
            self.assertEqual(re.search(r"^name: (\S+)$", head, re.M).group(1), folder.split("/")[-1])

    def test_connector_signs_in_by_dynamic_registration(self):
        (conn,) = self.manifest["agentConnectors"]
        server = conn["toolSource"]["remoteMcpServer"]
        self.assertEqual(server["mcpServerUrl"], "https://api.parallelfrontier.io/mcp")
        self.assertNotIn("authorization", server)  # Cowork registers itself (DCR) when this is absent
        self.assertIn(server["mcpToolDescription"]["file"], self.names)

    def test_tool_description_lists_every_tool_the_skill_names(self):
        (conn,) = self.manifest["agentConnectors"]
        tools = json.loads(self.zip.read(conn["toolSource"]["remoteMcpServer"]["mcpToolDescription"]["file"]))
        names = [t["name"] for t in tools["tools"]]
        self.assertEqual(sorted(names), sorted(SKILL_TOOLS))
        for t in tools["tools"]:
            self.assertTrue(t["description"])
            self.assertEqual(t["inputSchema"]["type"], "object")
        skill = (ROOT / "plugin" / "skills" / "frontier" / "SKILL.md").read_text()
        for name in names:
            self.assertIn(f"`{name}`", skill)

    def test_icons_are_the_sizes_microsoft_requires(self):
        self.assertEqual(png_size(self.zip.read("color.png")), (192, 192))
        self.assertEqual(png_size(self.zip.read("outline.png")), (32, 32))

    def test_build_is_deterministic(self):
        again = build_copilot.build(Path(self.tmp.name) / "again.zip")
        self.assertEqual(again.read_bytes(), self.zip_path.read_bytes())


if __name__ == "__main__":
    unittest.main()
