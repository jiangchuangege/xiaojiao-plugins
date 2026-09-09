import os
import re
from pathlib import Path

class WorkspaceSearch:
    """工作区代码搜索插件 - 让模型能在指定目录中搜索文件和代码"""
    
    def __init__(self):
        # 默认搜索当前目录，用户可以在小焦配置里改成自己的项目路径
        self.workspace_root = os.environ.get("XIAOJIAO_WORKSPACE", ".")
    
    def get_tool_descriptions(self):
        return [
            {
                "name": "search_files",
                "description": "在工作区中按文件名搜索，支持通配符，如 *.py, test_*.js",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "pattern": {
                            "type": "string",
                            "description": "文件名匹配模式，支持 * 通配符，如 '*.py' 或 'test_*.js'"
                        },
                        "directory": {
                            "type": "string",
                            "description": "可选，搜索的子目录，不填则搜索整个工作区"
                        }
                    },
                    "required": ["pattern"]
                }
            },
            {
                "name": "search_content",
                "description": "在工作区文件中按关键词搜索代码内容，返回匹配的行和上下文",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "query": {
                            "type": "string",
                            "description": "要搜索的关键词或正则表达式"
                        },
                        "file_pattern": {
                            "type": "string",
                            "description": "可选，只搜索匹配的文件，如 '*.py'，默认搜索所有文本文件"
                        },
                        "directory": {
                            "type": "string",
                            "description": "可选，搜索的子目录"
                        },
                        "context_lines": {
                            "type": "integer",
                            "description": "可选，匹配行上下文的行数，默认2行"
                        }
                    },
                    "required": ["query"]
                }
            },
            {
                "name": "list_directory",
                "description": "列出工作区中指定目录的内容，了解项目结构",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "directory": {
                            "type": "string",
                            "description": "要列出的目录路径，相对于工作区根目录"
                        },
                        "recursive": {
                            "type": "boolean",
                            "description": "是否递归列出子目录，默认false"
                        }
                    }
                }
            }
        ]
    
    def execute(self, name, params):
        if name == "search_files":
            return self._search_files(
                params.get("pattern", "*"),
                params.get("directory", "")
            )
        elif name == "search_content":
            return self._search_content(
                params.get("query", ""),
                params.get("file_pattern", "*"),
                params.get("directory", ""),
                params.get("context_lines", 2)
            )
        elif name == "list_directory":
            return self._list_directory(
                params.get("directory", ""),
                params.get("recursive", False)
            )
        return {"error": f"未知工具: {name}"}
    
    def _get_abs_path(self, rel_path=""):
        """将相对路径转为绝对路径，确保在工作区内"""
        base = Path(self.workspace_root).resolve()
        target = (base / rel_path).resolve()
        # 安全防护：不允许访问工作区外的路径
        if not str(target).startswith(str(base)):
            return None
        return target
    
    def _search_files(self, pattern, directory):
        """按文件名搜索"""
        base_dir = self._get_abs_path(directory)
        if base_dir is None:
            return {"error": "路径访问被拒绝，只能访问工作区内的目录"}
        if not base_dir.exists():
            return {"error": f"目录不存在: {directory}"}
        
        # 将通配符转为正则
        regex_pattern = pattern.replace(".", "\\.").replace("*", ".*").replace("?", ".")
        results = []
        
        for file_path in base_dir.rglob("*"):
            if file_path.is_file() and re.match(regex_pattern, file_path.name, re.IGNORECASE):
                # 忽略常见的隐藏目录和缓存
                if any(part.startswith(".") or part == "__pycache__" or part == "node_modules" 
                       for part in file_path.relative_to(base_dir).parts):
                    continue
                results.append(str(file_path.relative_to(base_dir)))
        
        if not results:
            return {"message": f"未找到匹配 '{pattern}' 的文件", "count": 0, "files": []}
        
        return {
            "count": len(results),
            "files": results[:50],  # 限制返回数量
            "message": f"找到 {len(results)} 个匹配文件，显示前50个"
        }
    
    def _search_content(self, query, file_pattern, directory, context_lines):
        """按内容搜索"""
        base_dir = self._get_abs_path(directory)
        if base_dir is None:
            return {"error": "路径访问被拒绝"}
        if not base_dir.exists():
            return {"error": f"目录不存在: {directory}"}
        
        # 文件匹配模式
        file_regex = file_pattern.replace(".", "\\.").replace("*", ".*").replace("?", ".")
        
        # 文本文件扩展名
        text_extensions = {'.py', '.js', '.ts', '.java', '.go', '.rs', '.c', '.cpp', '.h', 
                          '.html', '.css', '.json', '.xml', '.yaml', '.yml', '.toml', 
                          '.md', '.txt', '.sh', '.bash', '.conf', '.ini', '.cfg'}
        
        results = []
        try:
            query_regex = re.compile(query, re.IGNORECASE)
        except re.error:
            # 如果正则无效，按普通字符串搜索
            query_regex = re.compile(re.escape(query), re.IGNORECASE)
        
        for file_path in base_dir.rglob("*"):
            if not file_path.is_file():
                continue
            # 只搜索文本文件
            if file_path.suffix not in text_extensions:
                continue
            # 匹配文件模式
            if not re.match(file_regex, file_path.name, re.IGNORECASE):
                continue
            # 忽略隐藏目录和缓存
            if any(part.startswith(".") or part == "__pycache__" or part == "node_modules" 
                   for part in file_path.relative_to(base_dir).parts):
                continue
            
            try:
                with open(file_path, 'r', encoding='utf-8') as f:
                    lines = f.readlines()
            except (UnicodeDecodeError, PermissionError):
                continue
            
            matches = []
            for i, line in enumerate(lines):
                if query_regex.search(line):
                    start = max(0, i - context_lines)
                    end = min(len(lines), i + context_lines + 1)
                    context = "".join(lines[start:end])
                    matches.append({
                        "line_number": i + 1,
                        "content": line.strip(),
                        "context": context.strip()
                    })
            
            if matches:
                results.append({
                    "file": str(file_path.relative_to(base_dir)),
                    "matches": matches[:10]  # 每个文件最多返回10处匹配
                })
        
        if not results:
            return {"message": f"未找到包含 '{query}' 的内容", "count": 0, "results": []}
        
        return {
            "count": len(results),
            "results": results[:20],  # 最多返回20个文件
            "message": f"在 {len(results)} 个文件中找到匹配"
        }
    
    def _list_directory(self, directory, recursive):
        """列出目录内容"""
        base_dir = self._get_abs_path(directory)
        if base_dir is None:
            return {"error": "路径访问被拒绝"}
        if not base_dir.exists():
            return {"error": f"目录不存在: {directory}"}
        
        items = []
        for item in base_dir.iterdir():
            # 忽略隐藏文件
            if item.name.startswith("."):
                continue
            items.append({
                "name": item.name,
                "type": "dir" if item.is_dir() else "file",
                "size": item.stat().st_size if item.is_file() else 0
            })
        
        # 递归子目录
        if recursive:
            for item in base_dir.iterdir():
                if item.is_dir() and not item.name.startswith("."):
                    sub_items = self._list_directory(str(item.relative_to(self.workspace_root)), False)
                    if isinstance(sub_items, dict) and "items" in sub_items:
                        items.extend(sub_items["items"])
        
        items.sort(key=lambda x: (x["type"] == "file", x["name"]))
        
        return {
            "directory": directory or ".",
            "count": len(items),
            "items": items[:100]  # 限制返回数量
        }
