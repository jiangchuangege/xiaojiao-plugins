"""
Database Helper Plugin for XiaoJiao
功能：连接 SQLite 数据库，查表、查结构、执行查询、导出数据
Author: Your Name
Version: 1.0.0
"""

import sqlite3
import json
import re
import os
from pathlib import Path
from datetime import datetime

class DBHelper:
    """
    数据库管理插件，支持 SQLite 只读查询
    """

    def __init__(self):
        # 默认数据库路径（可通过环境变量覆盖）
        self.default_db = os.environ.get("XIAOJIAO_DB_PATH", "data.db")
        # 当前连接的数据库
        self.current_db = None
        self.connection = None

    def get_tool_descriptions(self):
        """返回所有工具定义"""
        return [
            {
                "name": "connect_db",
                "description": "连接到一个 SQLite 数据库文件",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "db_path": {
                            "type": "string",
                            "description": "数据库文件路径（相对于工作区）"
                        }
                    },
                    "required": ["db_path"]
                }
            },
            {
                "name": "list_tables",
                "description": "列出当前数据库中所有表名",
                "parameters": {
                    "type": "object",
                    "properties": {}
                }
            },
            {
                "name": "describe_table",
                "description": "查看表结构（列名、类型、是否可空、主键）",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "table_name": {
                            "type": "string",
                            "description": "表名"
                        }
                    },
                    "required": ["table_name"]
                }
            },
            {
                "name": "query_db",
                "description": "执行 SELECT 查询语句（只读），返回结果集",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "sql": {
                            "type": "string",
                            "description": "SELECT 查询语句"
                        },
                        "limit": {
                            "type": "integer",
                            "description": "可选，限制返回行数，默认 100"
                        }
                    },
                    "required": ["sql"]
                }
            },
            {
                "name": "export_table_json",
                "description": "将整张表导出为 JSON 格式",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "table_name": {
                            "type": "string",
                            "description": "表名"
                        },
                        "limit": {
                            "type": "integer",
                            "description": "可选，限制导出行数，默认 500"
                        }
                    },
                    "required": ["table_name"]
                }
            }
        ]

    def execute(self, tool_name, params):
        """执行工具"""
        method_map = {
            "connect_db": self._connect_db,
            "list_tables": self._list_tables,
            "describe_table": self._describe_table,
            "query_db": self._query_db,
            "export_table_json": self._export_table_json
        }
        method = method_map.get(tool_name)
        if not method:
            return {"error": f"未知工具: {tool_name}"}
        try:
            return method(params)
        except Exception as e:
            return {"error": str(e)}

    # ---------- 内部实现 ----------

    def _get_connection(self):
        """获取当前连接，如果未连接则尝试默认数据库"""
        if self.connection is not None:
            return self.connection
        # 尝试连接默认数据库
        if os.path.exists(self.default_db):
            self.connection = sqlite3.connect(self.default_db)
            self.connection.row_factory = sqlite3.Row
            self.current_db = self.default_db
            return self.connection
        raise Exception("未连接数据库，请先调用 connect_db 工具")

    def _safe_db_path(self, path):
        """安全处理路径"""
        base = Path.cwd().resolve()
        target = (base / path).resolve()
        # 只允许访问当前目录下的文件
        if not str(target).startswith(str(base)):
            raise PermissionError("禁止访问工作区外的数据库文件")
        return str(target)

    def _is_readonly_query(self, sql):
        """检查是否为只读 SELECT 查询，防止注入修改"""
        # 去掉注释和多余空白
        cleaned = re.sub(r'--.*$', '', sql, flags=re.MULTILINE)
        cleaned = re.sub(r'/\*.*?\*/', '', cleaned, flags=re.DOTALL)
        cleaned = cleaned.strip().lower()
        # 必须是以 select 开头
        if not cleaned.startswith('select'):
            return False
        # 禁止包含危险关键词（防止绕过）
        dangerous = ['insert', 'update', 'delete', 'drop', 'alter', 'create', 'attach', 'detach', 'pragma']
        for word in dangerous:
            if re.search(r'\b' + word + r'\b', cleaned):
                return False
        return True

    def _connect_db(self, params):
        db_path = params.get("db_path", "")
        if not db_path:
            return {"error": "请提供数据库路径"}
        full_path = self._safe_db_path(db_path)
        if not os.path.exists(full_path):
            return {"error": f"数据库文件不存在: {db_path}"}
        if self.connection:
            self.connection.close()
        self.connection = sqlite3.connect(full_path)
        self.connection.row_factory = sqlite3.Row
        self.current_db = full_path
        # 获取数据库大小
        size_mb = os.path.getsize(full_path) / 1024 / 1024
        return {
            "message": f"✅ 成功连接到数据库: {os.path.basename(full_path)}",
            "size_mb": round(size_mb, 2),
            "path": full_path
        }

    def _list_tables(self, params):
        conn = self._get_connection()
        cursor = conn.cursor()
        # SQLite 系统表查询
        cursor.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        rows = cursor.fetchall()
        tables = [row[0] for row in rows]
        # 获取每个表的行数（估算）
        table_info = []
        for table in tables:
            try:
                cursor.execute(f"SELECT COUNT(*) FROM `{table}`")
                count = cursor.fetchone()[0]
            except:
                count = -1
            table_info.append({"name": table, "row_count": count})
        return {
            "count": len(table_info),
            "tables": table_info,
            "message": f"共 {len(table_info)} 张表"
        }

    def _describe_table(self, params):
        table_name = params.get("table_name", "")
        if not table_name:
            return {"error": "请提供表名"}
        conn = self._get_connection()
        cursor = conn.cursor()
        # 检查表是否存在
        cursor.execute("SELECT name FROM sqlite_master WHERE type='table' AND name=?", (table_name,))
        if not cursor.fetchone():
            return {"error": f"表 '{table_name}' 不存在"}
        # 获取表结构
        cursor.execute(f"PRAGMA table_info(`{table_name}`)")
        columns = cursor.fetchall()
        # 获取行数
        cursor.execute(f"SELECT COUNT(*) FROM `{table_name}`")
        row_count = cursor.fetchone()[0]
        result = {
            "table_name": table_name,
            "row_count": row_count,
            "columns": []
        }
        for col in columns:
            result["columns"].append({
                "name": col[1],
                "type": col[2],
                "nullable": not bool(col[3]),
                "default": col[4],
                "is_primary_key": bool(col[5])
            })
        # 获取索引信息（可选）
        cursor.execute(f"PRAGMA index_list(`{table_name}`)")
        indexes = cursor.fetchall()
        result["index_count"] = len(indexes)
        return result

    def _query_db(self, params):
        sql = params.get("sql", "")
        limit = params.get("limit", 100)
        if not sql:
            return {"error": "请提供 SQL 查询语句"}
        if not self._is_readonly_query(sql):
            return {"error": "仅允许 SELECT 只读查询，禁止修改操作"}
        conn = self._get_connection()
        cursor = conn.cursor()
        try:
            # 如果查询没有 limit，自动添加
            if 'limit' not in sql.lower():
                sql += f" LIMIT {limit}"
            cursor.execute(sql)
            rows = cursor.fetchall()
            if not rows:
                return {"message": "查询结果为空", "count": 0, "columns": [], "data": []}
            columns = [description[0] for description in cursor.description]
            data = [dict(row) for row in rows]
            return {
                "count": len(data),
                "columns": columns,
                "data": data[:1000],  # 最多返回1000行
                "sql": sql,
                "message": f"查询成功，返回 {len(data)} 行"
            }
        except sqlite3.Error as e:
            return {"error": f"SQL 执行错误: {str(e)}"}

    def _export_table_json(self, params):
        table_name = params.get("table_name", "")
        limit = params.get("limit", 500)
        if not table_name:
            return {"error": "请提供表名"}
        conn = self._get_connection()
        cursor = conn.cursor()
        # 检查表是否存在
        cursor.execute("SELECT name FROM sqlite_master WHERE type='table' AND name=?", (table_name,))
        if not cursor.fetchone():
            return {"error": f"表 '{table_name}' 不存在"}
        # 查询数据
        sql = f"SELECT * FROM `{table_name}` LIMIT {limit}"
        cursor.execute(sql)
        rows = cursor.fetchall()
        if not rows:
            return {"message": f"表 '{table_name}' 为空", "count": 0, "data": []}
        columns = [description[0] for description in cursor.description]
        data = [dict(row) for row in rows]
        return {
            "table": table_name,
            "exported_at": datetime.now().isoformat(),
            "count": len(data),
            "columns": columns,
            "data": data
        }
