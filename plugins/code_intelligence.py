"""
Code Intelligence Plugin for XiaoJiao
功能：文件搜索、内容检索、代码统计、依赖分析、项目结构树
Author: Your Name
Version: 1.0.0
"""

import os
import re
import json
import time
import subprocess
from pathlib import Path
from collections import Counter
from datetime import datetime

class CodeIntelligence:
    """
    多功能代码智能插件
    提供代码库的深度分析工具
    """

    def __init__(self):
        # 工作区根目录（可通过环境变量覆盖）
        self.workspace = os.environ.get("XIAOJIAO_WORKSPACE", os.getcwd())
        # 忽略的目录
        self.ignore_dirs = {'.git', '__pycache__', 'node_modules', '.venv', 'venv', '.idea', '.vscode', 'dist', 'build'}
        # 文本文件扩展名
        self.text_extensions = {
            '.py', '.js', '.ts', '.jsx', '.tsx', '.java', '.go', '.rs', '.c', '.cpp', '.h', '.hpp',
            '.html', '.css', '.scss', '.less', '.json', '.xml', '.yaml', '.yml', '.toml', '.ini', '.cfg',
            '.md', '.txt', '.rst', '.sh', '.bash', '.zsh', '.fish', '.sql', '.r', '.rb', '.php', '.lua'
        }

    def get_tool_descriptions(self):
        """返回所有工具的定义"""
        return [
            {
                "name": "search_files",
                "description": "按文件名通配符搜索文件，支持 * 和 ?",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "pattern": {"type": "string", "description": "通配符模式，如 '*.py'"},
                        "directory": {"type": "string", "description": "可选，搜索子目录"}
                    },
                    "required": ["pattern"]
                }
            },
            {
                "name": "search_content",
                "description": "在文件内容中搜索正则表达式或关键词，返回匹配行及上下文",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "query": {"type": "string", "description": "搜索关键词或正则"},
                        "file_pattern": {"type": "string", "description": "可选，文件过滤如 '*.py'"},
                        "directory": {"type": "string", "description": "可选，搜索子目录"},
                        "context_lines": {"type": "integer", "description": "上下文行数，默认2"}
                    },
                    "required": ["query"]
                }
            },
            {
                "name": "get_file_info",
                "description": "获取单个文件的详细信息：大小、行数、修改时间等",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "file_path": {"type": "string", "description": "相对于工作区的文件路径"}
                    },
                    "required": ["file_path"]
                }
            },
            {
                "name": "read_file",
                "description": "读取文件内容，可指定行范围，支持代码高亮（行号）",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "file_path": {"type": "string", "description": "文件路径"},
                        "start_line": {"type": "integer", "description": "起始行号（从1开始）"},
                        "end_line": {"type": "integer", "description": "结束行号"}
                    },
                    "required": ["file_path"]
                }
            },
            {
                "name": "count_code_lines",
                "description": "统计代码总行数、空行、注释行，按语言分类",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "directory": {"type": "string", "description": "可选，统计子目录"}
                    }
                }
            },
            {
                "name": "analyze_dependencies",
                "description": "分析项目依赖：提取 Python import、Node require 等",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "directory": {"type": "string", "description": "可选，分析子目录"}
                    }
                }
            },
            {
                "name": "project_tree",
                "description": "生成项目目录结构树，支持忽略配置",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "directory": {"type": "string", "description": "可选，起始目录"},
                        "max_depth": {"type": "integer", "description": "最大深度，默认3"}
                    }
                }
            }
        ]

    def execute(self, tool_name, params):
        """执行工具"""
        method_map = {
            "search_files": self._search_files,
            "search_content": self._search_content,
            "get_file_info": self._get_file_info,
            "read_file": self._read_file,
            "count_code_lines": self._count_code_lines,
            "analyze_dependencies": self._analyze_dependencies,
            "project_tree": self._project_tree
        }
        method = method_map.get(tool_name)
        if not method:
            return {"error": f"未知工具: {tool_name}"}
        try:
            return method(params)
        except Exception as e:
            return {"error": str(e)}

    # ---------- 内部实现 ----------

    def _safe_path(self, rel_path=""):
        """将相对路径转为绝对路径，防止目录遍历攻击"""
        base = Path(self.workspace).resolve()
        target = (base / rel_path).resolve()
        if not str(target).startswith(str(base)):
            raise PermissionError("禁止访问工作区外的路径")
        return target

    def _is_text_file(self, path):
        """判断是否为文本文件"""
        return path.suffix.lower() in self.text_extensions

    def _should_ignore(self, path):
        """检查是否应忽略该路径"""
        parts = path.parts
        for part in parts:
            if part in self.ignore_dirs or part.startswith('.'):
                return True
        return False

    def _search_files(self, params):
        pattern = params.get("pattern", "*")
        directory = params.get("directory", "")
        base = self._safe_path(directory)
        if not base.exists():
            return {"error": f"目录不存在: {directory}"}

        # 通配符转正则
        regex = re.compile(pattern.replace(".", "\\.").replace("*", ".*").replace("?", "."), re.IGNORECASE)
        results = []
        for p in base.rglob("*"):
            if p.is_file() and regex.match(p.name):
                rel = p.relative_to(base)
                if not self._should_ignore(rel):
                    results.append(str(rel))
        return {
            "count": len(results),
            "files": results[:100],
            "message": f"找到 {len(results)} 个文件，显示前100个"
        }

    def _search_content(self, params):
        query = params.get("query", "")
        file_pattern = params.get("file_pattern", "*")
        directory = params.get("directory", "")
        context = params.get("context_lines", 2)
        base = self._safe_path(directory)
        if not base.exists():
            return {"error": f"目录不存在: {directory}"}

        # 编译正则
        try:
            regex = re.compile(query, re.IGNORECASE)
        except re.error:
            regex = re.compile(re.escape(query), re.IGNORECASE)

        # 文件匹配
        file_regex = re.compile(file_pattern.replace(".", "\\.").replace("*", ".*").replace("?", "."), re.IGNORECASE)

        results = []
        for p in base.rglob("*"):
            if not p.is_file() or not self._is_text_file(p):
                continue
            rel = p.relative_to(base)
            if self._should_ignore(rel) or not file_regex.match(p.name):
                continue
            try:
                with open(p, 'r', encoding='utf-8') as f:
                    lines = f.readlines()
            except (UnicodeDecodeError, PermissionError):
                continue
            matches = []
            for i, line in enumerate(lines):
                if regex.search(line):
                    start = max(0, i - context)
                    end = min(len(lines), i + context + 1)
                    matches.append({
                        "line": i + 1,
                        "text": line.strip(),
                        "context": "".join(lines[start:end]).strip()
                    })
            if matches:
                results.append({
                    "file": str(rel),
                    "matches": matches[:10]
                })
        return {
            "count": len(results),
            "results": results[:20],
            "message": f"在 {len(results)} 个文件中找到匹配"
        }

    def _get_file_info(self, params):
        rel_path = params.get("file_path", "")
        p = self._safe_path(rel_path)
        if not p.exists():
            return {"error": f"文件不存在: {rel_path}"}
        if not p.is_file():
            return {"error": f"路径不是文件: {rel_path}"}
        stat = p.stat()
        info = {
            "name": p.name,
            "size_bytes": stat.st_size,
            "size_mb": round(stat.st_size / 1024 / 1024, 2),
            "modified": datetime.fromtimestamp(stat.st_mtime).isoformat(),
            "created": datetime.fromtimestamp(stat.st_ctime).isoformat(),
            "is_text": self._is_text_file(p)
        }
        if info["is_text"]:
            try:
                with open(p, 'r', encoding='utf-8') as f:
                    info["line_count"] = sum(1 for _ in f)
            except:
                info["line_count"] = -1
        return info

    def _read_file(self, params):
        rel_path = params.get("file_path", "")
        start = params.get("start_line", 1)
        end = params.get("end_line", None)
        p = self._safe_path(rel_path)
        if not p.exists() or not p.is_file():
            return {"error": f"文件不存在: {rel_path}"}
        if not self._is_text_file(p):
            return {"error": "不是文本文件"}
        try:
            with open(p, 'r', encoding='utf-8') as f:
                lines = f.readlines()
        except:
            return {"error": "读取文件失败"}
        total = len(lines)
        if start < 1:
            start = 1
        if end is None or end > total:
            end = total
        if start > end:
            return {"error": "起始行号大于结束行号"}
        content = "".join(lines[start-1:end])
        return {
            "file": rel_path,
            "total_lines": total,
            "start_line": start,
            "end_line": end,
            "content": content
        }

    def _count_code_lines(self, params):
        directory = params.get("directory", "")
        base = self._safe_path(directory)
        if not base.exists():
            return {"error": f"目录不存在: {directory}"}
        stats = Counter()
        total_files = 0
        for p in base.rglob("*"):
            if not p.is_file() or not self._is_text_file(p):
                continue
            rel = p.relative_to(base)
            if self._should_ignore(rel):
                continue
            total_files += 1
            ext = p.suffix or "no_ext"
            try:
                with open(p, 'r', encoding='utf-8') as f:
                    lines = f.readlines()
            except:
                continue
            lines_count = len(lines)
            stats[ext] += lines_count
            # 简单统计空行和注释（只对Python/JS等）
            if ext in ['.py', '.js', '.ts', '.java']:
                blank = sum(1 for l in lines if l.strip() == '')
                stats[ext + "_blank"] += blank
                # 粗略注释行
                comment = sum(1 for l in lines if l.strip().startswith(('#', '//', '/*')))
                stats[ext + "_comment"] += comment
        return {
            "total_files": total_files,
            "total_lines": sum(stats.values()),
            "by_extension": dict(stats),
            "message": f"共统计 {total_files} 个文件"
        }

    def _analyze_dependencies(self, params):
        directory = params.get("directory", "")
        base = self._safe_path(directory)
        if not base.exists():
            return {"error": f"目录不存在: {directory}"}
        deps = {"python": [], "node": []}
        for p in base.rglob("*"):
            if not p.is_file():
                continue
            rel = p.relative_to(base)
            if self._should_ignore(rel):
                continue
            if p.suffix == '.py':
                try:
                    with open(p, 'r', encoding='utf-8') as f:
                        for line in f:
                            m = re.match(r'^\s*import\s+(\w+)|^\s*from\s+(\w+)', line)
                            if m:
                                dep = m.group(1) or m.group(2)
                                if dep not in deps['python']:
                                    deps['python'].append(dep)
                except:
                    pass
            elif p.suffix == '.js' or p.suffix == '.ts':
                try:
                    with open(p, 'r', encoding='utf-8') as f:
                        content = f.read()
                        matches = re.findall(r'require\([\'"]([^\'"]+)[\'"]\)|import\s+.*?from\s+[\'"]([^\'"]+)[\'"]', content)
                        for m in matches:
                            dep = m[0] or m[1]
                            if dep and dep not in deps['node']:
                                deps['node'].append(dep)
                except:
                    pass
        return {
            "python_imports": deps['python'][:50],
            "node_requires": deps['node'][:50],
            "message": f"找到 {len(deps['python'])} 个Python依赖，{len(deps['node'])} 个Node依赖"
        }

    def _project_tree(self, params):
        directory = params.get("directory", "")
        max_depth = params.get("max_depth", 3)
        base = self._safe_path(directory)
        if not base.exists():
            return {"error": f"目录不存在: {directory}"}

        def build_tree(path, depth=0):
            if depth > max_depth:
                return {"name": path.name, "type": "dir", "children": []}
            items = []
            for child in path.iterdir():
                if self._should_ignore(child):
                    continue
                if child.is_dir():
                    items.append(build_tree(child, depth+1))
                else:
                    items.append({"name": child.name, "type": "file"})
            items.sort(key=lambda x: (x["type"] == "file", x["name"]))
            return {"name": path.name, "type": "dir", "children": items}

        tree = build_tree(base)
        return tree
      
