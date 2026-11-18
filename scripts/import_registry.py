"""Import the litigation registry into a local SQLite database (standard library only).

    python scripts/import_registry.py "诉讼组—股民登记表格.xlsx" --db path/to/db.sqlite

Only 股民登记总表 is read. The other application tables and the XLSX are not edited.
"""

import argparse
from collections import Counter
from datetime import date, datetime, timedelta, timezone
import hashlib
import json
from pathlib import Path
import posixpath
import re
import sqlite3
import sys
import unicodedata
from xml.etree import ElementTree as ET
from zipfile import BadZipFile, ZipFile


NS = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
REL = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"
SHEET = "股民登记总表"
HEADERS = {
    "序号": "serial", "客户名称": "customer", "股票名称": "stock_name", "股票代码": "stock_code",
    "销售": "sales", "原告-合同上的联系电话": "phone", "客户来源": "source",
    "材料登记时间": "registered_on", "是否立案": "filed", "立案时间": "filed_on",
    "案件进展": "progress", "是否结案": "closed",
}
OPTIONAL_HEADERS = {
    "一审案号": "first_case", "是否上诉": "appeal", "二审案号": "appeal_case", "二审开庭时间": "appeal_hearing",
    "是否执行立案": "execution_filed", "执行申请日期": "execution_date", "执行案号": "execution_case",
    "执行进展": "execution_progress", "赔偿款是否收到": "firm_receipt", "赔偿款是否支付给原告": "paid_out",
    "结案方式": "closing_method", "合同号": "contract", "合同编号": "contract",
}
BASE_DATA = ["customer", "phone", "sales", "stock_name", "stock_code", "source", "registered_on", "filed_on", "stage"]
DETAIL_DATA = ["progress_stage", "progress_node", "contract_number"]
DATA = BASE_DATA + DETAIL_DATA
COLUMNS = ["entry_key", "source_row", *DATA]
PLACEHOLDERS = {"无", "暂无", "未登记", "待定", "未知", "不详", "未标注", "无销售", "-", "—", "/", "待确认", "无名", "销售", "姓名"}
# A source is displayed as a category; free-text recommender/contact information is omitted.
SOURCES = {
    "大众证券", "东方财富", "东方财富维权平台", "百度优化", "投资快报", "新浪", "商务推荐",
    "抖音", "券商推荐", "老客户介绍", "老客户推荐", "客户推荐", "销售自己客户", "自然流入",
    "公众号", "微信公众号", "官网", "网站", "股吧", "华夏时报", "北京辉圣延", "山狐信息",
}
# Use actual registry terms. More detailed narrative or mixed statuses are never copied.
STAGES = {
    "待受理", "已受理", "诉讼中", "未立案", "已立案", "已立案未开庭", "已开庭", "一审待开庭",
    "一审已开庭", "二审待开庭", "二审已开庭", "已判决", "已上诉", "撤诉", "已撤诉",
    "执行中", "已结案", "终结执行",
    "重整债权已申报", "破产债权已申报", "重整债权已确认", "判决生效待执行", "立案退回", "已提交调解申请",
}

# Only source labels that identify both a phase and a particular node are mapped.
# Raw narratives, case numbers and payment details are never returned as stage labels.
PROGRESS_POINTS = {
    "已留资": ("intake", "lead_received"), "已签约": ("intake", "signed"),
    "已签约待立案": ("intake", "signed_waiting_filing"),
    "立案材料准备中": ("filing", "preparing"), "已提交立案": ("filing", "submitted"),
    "立案待补充材料": ("filing", "supplement"),
    "一审待开庭": ("first_hearing", "awaiting_hearing"), "一审已开庭待判决": ("first_hearing", "awaiting_judgment"),
    "一审等待判决结果": ("first_hearing", "awaiting_judgment"),
    "一审判决待生效": ("first_hearing", "judgment_pending_effective"),
    "一审判决已生效": ("first_hearing", "judgment_effective"),
    "二审待开庭": ("appeal", "awaiting_hearing"), "二审上诉待开庭": ("appeal", "awaiting_hearing"),
    "二审已开庭待判决": ("appeal", "awaiting_judgment"), "二审等待判决结果": ("appeal", "awaiting_judgment"),
    "二审判决待生效": ("appeal", "judgment_pending_effective"), "案件已发回重审": ("appeal", "remanded"),
    "二审发回重审": ("appeal", "remanded"), "已达成调解或和解": ("settlement", "agreed"),
    "已调解待支付": ("settlement", "pending_payment"), "已和解待支付": ("settlement", "pending_payment"),
    "执行中": ("enforcement", "in_progress"), "执行获赔": ("enforcement", "compensated"),
    "债权申报准备中": ("debt_claim", "preparing"), "债权申报待补充材料": ("debt_claim", "supplement"),
    "债权申报获赔": ("debt_claim", "compensated"), "赔款已到账": ("closure", "payment_received"),
    "已结案": ("closure", "closed"),
}
YES = {"是", "√"}
NO = {"否", "×"}
NOT_RECORDED = {"", "/", "—", "-", "无", "否", "×", "未上诉"}
CHECK_PROGRESS = "案件进度待核对"
FIRST_CASE_NUMBER = re.compile(r"\(\d{4}\)[\u3400-\u9fff0-9]{1,14}民初(?:字第|第)?\d+号?")


class RegistryError(Exception):
    pass


def clean(value):
    return unicodedata.normalize("NFKC", value or "").strip()


def groups(stream, tag):
    """Yield one complete row/string, then release both the element and its parent reference."""
    stack = []
    for event, node in ET.iterparse(stream, events=("start", "end")):
        if event == "start":
            stack.append(node)
            continue
        if node.tag == NS + tag:
            yield node
            stack[-2].remove(node)
        stack.pop()


def string_text(obj):
    # Rich text may contain phonetic annotations; do not concatenate those into names.
    return "".join(node.text or "" for node in obj.findall(NS + "t") + obj.findall(f"{NS}r/{NS}t"))


def sheet_settings(book):
    wb = ET.fromstring(book.read("xl/workbook.xml"))
    matches = [s for s in wb.iter(NS + "sheet") if s.get("name") == SHEET]
    if len(matches) != 1:
        raise RegistryError("没有找到唯一的股民登记总表")
    props = wb.find(NS + "workbookPr")
    epoch1904 = props is not None and props.get("date1904") in {"1", "true"}
    rid = matches[0].get(REL + "id")
    rels = ET.fromstring(book.read("xl/_rels/workbook.xml.rels"))
    targets = [r.get("Target", "") for r in rels if r.get("Id") == rid and r.get("TargetMode") != "External"]
    if len(targets) != 1:
        raise RegistryError("工作表引用无效")
    target = targets[0]
    path = posixpath.normpath(target.lstrip("/") if target.startswith("/") else posixpath.join("xl", target))
    if not path.startswith("xl/worksheets/"):
        raise RegistryError("工作表路径无效")
    return path, epoch1904


def cell_value(cell, strings):
    # Formula caches, external references and Excel error cells are not trusted source data.
    if cell.find(NS + "f") is not None:
        return ""
    typ = cell.get("t", "n")
    value = cell.findtext(NS + "v", "")
    if typ == "s":
        if not value.isascii() or not value.isdigit() or int(value) >= len(strings):
            raise RegistryError("工作簿字符串索引无效")
        return strings[int(value)]
    if typ == "inlineStr":
        inline = cell.find(NS + "is")
        return string_text(inline) if inline is not None else ""
    return value if typ in {"n", "d", "str"} else ""


def iso_date(raw, epoch1904):
    value = clean(raw)
    if not value:
        return ""
    stamp = re.fullmatch(r"(\d{4})[-年./](\d{1,2})[-月./](\d{1,2})日?(?:(?:T| )\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?)?", value)
    try:
        if stamp:
            day = date(*map(int, stamp.groups()))
        elif re.fullmatch(r"\d{4,5}(?:\.\d+)?", value):
            serial = int(value.partition(".")[0])
            day = date(1904, 1, 1) + timedelta(days=serial) if epoch1904 else date(1899, 12, 30) + timedelta(days=serial)
        else:
            return ""
        return day.isoformat() if 1904 <= day.year <= 2099 else ""
    except (ValueError, OverflowError):
        return ""


def safe_field(raw, max_len):
    if not raw or raw in PLACEHOLDERS or len(raw) > max_len or re.search(r"[\x00-\x1f\x7f]", raw):
        return ""
    if raw.startswith(("=", "@", "http:", "https:")) or re.search(r"\d{8,}", raw):
        return ""
    return raw


def source_category(value):
    if value in SOURCES or (value.endswith("客户推荐") and value[:-4] in SOURCES):
        return value
    return ""


def source_progress(row):
    progress = row["progress"]
    closed = row["closed"]
    if closed in YES | {"已结案", "结案"}:
        return "已结案"
    if progress == "已结案":
        return CHECK_PROGRESS if closed in NO | {"未结案"} else progress
    method = row.get("closing_method", "")
    # An explicit outcome, even when the separate closing flag has not been set.
    if method in {"执行获赔", "债权申报获赔"}:
        return method
    if progress in {"赔款已到账", "执行获赔", "债权申报获赔"}:
        return progress
    if method not in NOT_RECORDED or row.get("firm_receipt") in YES or row.get("paid_out") in YES:
        # A receipt by the firm or a transfer instruction is not client bank confirmation.
        return CHECK_PROGRESS
    execution = row.get("execution_progress", "")
    has_execution = any(row.get(k, "") not in NOT_RECORDED for k in
                        ("execution_progress", "execution_case", "execution_date", "execution_filed"))
    if has_execution:
        if execution in {"执行中", "立案执行"} and progress in {"", "执行中", "判决生效待执行", "已立案未开庭"}:
            return "执行中"
        if progress != "执行中" or execution not in NOT_RECORDED | {"执行中", "立案执行"}:
            return CHECK_PROGRESS
    has_appeal = any(row.get(k, "") not in NOT_RECORDED for k in ("appeal", "appeal_case", "appeal_hearing"))
    phase, _ = PROGRESS_POINTS.get(progress, ("", ""))
    if has_appeal and (phase in {"intake", "filing", "first_hearing"} or progress in {"已立案未开庭", ""}):
        return CHECK_PROGRESS
    filed = row["filed"] in YES | {"已立案"} or FIRST_CASE_NUMBER.fullmatch(row.get("first_case", ""))
    if filed and (phase == "intake" or progress == "立案材料准备中"):
        return CHECK_PROGRESS
    if (progress == "已立案未开庭" and row["filed"] not in NO | {"立案退回", "材料退回", "撤诉", "未立案"}
            and FIRST_CASE_NUMBER.fullmatch(row.get("first_case", ""))):
        return "一审待开庭"
    if progress:
        return progress if progress in STAGES or progress in PROGRESS_POINTS else CHECK_PROGRESS
    if row["filed"] == "债权申报":
        return "债权申报"
    if row["filed"] in {"是", "已立案", "√"}:
        return "已立案"
    if row["filed"] in {"否", "未立案"}:
        return "未立案"
    return ""


def contract_number(raw):
    # Only the dedicated contract-number column may supply an identifier.
    # Multiple numbers, prose, phone numbers, case numbers and identity numbers are not accepted.
    if not raw or not re.fullmatch(r"[A-Za-z0-9\u3400-\u9fff(][A-Za-z0-9\u3400-\u9fff()._\-]{0,63}", raw):
        return ""
    if not re.search(r"[0-9]", raw) or re.fullmatch(r"(?:1[3-9]\d{9}|\d{17}[0-9Xx])", raw):
        return ""
    if re.search(r"民[初终申再]|待核|备注|手机号|电话|身份证", raw):
        return ""
    return raw


def digest(parts):
    return hashlib.sha256(json.dumps(parts, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()


def normalize(row, epoch1904, counts):
    customer = safe_field(row["customer"], 80)
    stock = safe_field(row["stock_name"], 60)
    if not row["customer"] or not stock or customer in HEADERS or row["customer"] in {"合计", "总计", "小计"}:
        counts["skipped_no_customer_or_stock"] += 1
        return None
    # Preserve an otherwise valid registration carrying a non-name note, but do
    # not let a redacted/shared placeholder become an account-matching identity.
    if not customer:
        counts["customer_needs_review"] += 1
    # The supplied registry uses six-digit A-share codes (both numeric and text).
    # Text keeps leading zeroes; numeric-looking short values are not silently padded.
    code = row["stock_code"].upper()
    if not re.fullmatch(r"(?:[0-9]{6}|[A-Z][A-Z0-9.-]{0,19})", code):
        code = ""
    sales = safe_field(row["sales"], 32)
    if not re.fullmatch(r"\*?[\u3400-\u9fffA-Za-z][\u3400-\u9fffA-Za-z0-9·._-]{0,30}", sales):
        sales = ""
    phone = row["phone"] if customer and re.fullmatch(r"1[3-9][0-9]{9}", row["phone"]) else ""
    source = source_category(row["source"])
    registered = iso_date(row["registered_on"], epoch1904)
    filed = iso_date(row["filed_on"], epoch1904)
    stage = source_progress(row)
    progress_stage, node = PROGRESS_POINTS.get(stage, ("", ""))
    contract = contract_number(row.get("contract", ""))
    for name, value in [("phone", phone), ("sales", sales), ("source", source), ("stock_code", code),
                        ("registered_on", registered), ("filed_on", filed), ("stage", stage),
                        ("progress_node", node), ("contract_number", contract)]:
        if value:
            counts[f"with_{name}"] += 1
    return (customer or "股民姓名待核对", phone, sales, stock, code, source, registered, filed, stage,
            progress_stage, node, contract)


def registry_rows(book, counts):
    path, epoch1904 = sheet_settings(book)
    strings = []
    if "xl/sharedStrings.xml" in book.namelist():
        with book.open("xl/sharedStrings.xml") as shared:
            strings = [string_text(item) for item in groups(shared, "si")]
    colmap = {}
    with book.open(path) as sheet:
        for row in groups(sheet, "row"):
            row_number = int(row.get("r", "0"))
            if not colmap and row_number > 12:
                raise RegistryError("未在表首找到完整登记表表头")
            cells = {}
            for c in row.iter(NS + "c"):
                ref = re.fullmatch(r"([A-Z]+)[1-9][0-9]*", c.get("r", ""))
                if ref and (not colmap or ref[1] in colmap):
                    cells[ref[1]] = clean(cell_value(c, strings))
            if not colmap:
                headers = {col: HEADERS[text] for col, text in cells.items() if text in HEADERS}
                if set(headers.values()) == set(HEADERS.values()):
                    if len(headers) != len(HEADERS):
                        raise RegistryError("登记表含重复的关键表头")
                    extras = {col: OPTIONAL_HEADERS[text] for col, text in cells.items() if text in OPTIONAL_HEADERS}
                    if len(set(extras.values())) != len(extras):
                        raise RegistryError("登记表含重复的详情表头")
                    headers.update(extras)
                    colmap = headers
                continue
            if not any(cells.values()):
                continue
            counts["source_rows"] += 1
            record = {key: cells.get(col, "") for col, key in colmap.items()}
            fields = normalize(record, epoch1904, counts)
            if fields:
                counts["accepted_rows"] += 1
                yield (record["serial"], row_number, *fields)
        if not colmap:
            raise RegistryError("工作表缺少必需列")


def stage_workbook(db, path, counts):
    db.execute(f"CREATE TEMP TABLE incoming (serial TEXT,source_row INTEGER PRIMARY KEY,{','.join(DATA)})")
    with ZipFile(path) as book:
        db.executemany(f"INSERT INTO incoming VALUES ({','.join('?' for _ in range(2+len(DATA)))})", registry_rows(book, counts))
    if not counts["accepted_rows"]:
        raise RegistryError("没有可导入的登记记录，现有台账保留")
    db.execute(f"CREATE TEMP TABLE snapshot (entry_key TEXT PRIMARY KEY,source_row INTEGER,{','.join(DATA)})")
    # The published serial plus customer/stock guards against re-numbering that might
    # otherwise assign an old reference to a different person. For ambiguous identities,
    # include normalized row contents; identical duplicate registrations remain separate.
    rows = db.execute(f"SELECT serial,source_row,{','.join(DATA)} FROM incoming ORDER BY source_row")
    all_rows = rows.fetchall()
    def row_identity(r):
        return (r[0], r[2], r[6] or r[5])
    identities = Counter(row_identity(r) for r in all_rows)
    occurrences = Counter()
    def keyed():
        for r in all_rows:
            identity = row_identity(r)
            if identity[0] and identities[identity] == 1:
                key = digest([SHEET, *identity])
            else:
                counts["fallback_key_rows"] += 1
                fingerprint = digest([SHEET, *identity, *r[2:2 + len(BASE_DATA)]])
                occurrences[fingerprint] += 1
                key = digest([fingerprint, occurrences[fingerprint]])
            yield (key, *r[1:])
    db.executemany(f"INSERT INTO snapshot VALUES ({','.join('?' for _ in COLUMNS)})", keyed())


def sync(db, source_name, counts):
    db.execute("BEGIN IMMEDIATE")
    try:
        optional_fields = ",".join(f"{key} TEXT NOT NULL DEFAULT ''" for key in DATA[1:])
        db.execute("CREATE TABLE IF NOT EXISTS registry_entries(entry_key TEXT PRIMARY KEY,"
                   f"source_row INTEGER NOT NULL,customer TEXT NOT NULL,{optional_fields})")
        db.execute("CREATE TABLE IF NOT EXISTS registry_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL)")
        existing = {row[1] for row in db.execute("PRAGMA table_info(registry_entries)")}
        for field in DETAIL_DATA:
            if field not in existing:
                db.execute(f"ALTER TABLE registry_entries ADD COLUMN {field} TEXT NOT NULL DEFAULT ''")
        columns = ",".join(COLUMNS)
        add, update, remove = (
            db.execute(sql).fetchone()[0] for sql in (
                "SELECT count(*) FROM snapshot s WHERE NOT EXISTS (SELECT 1 FROM registry_entries e WHERE e.entry_key=s.entry_key)",
                "SELECT count(*) FROM snapshot s JOIN registry_entries e USING(entry_key) WHERE " +
                " OR ".join(f"e.{k} IS NOT s.{k}" for k in COLUMNS[1:]),
                "SELECT count(*) FROM registry_entries e WHERE NOT EXISTS (SELECT 1 FROM snapshot s WHERE s.entry_key=e.entry_key)",
            )
        )
        if add or update or remove:
            db.execute(f"INSERT INTO registry_entries({columns}) SELECT {columns} FROM snapshot WHERE true "
                       "ON CONFLICT(entry_key) DO UPDATE SET " + ",".join(f"{k}=excluded.{k}" for k in COLUMNS[1:]) +
                       " WHERE " + " OR ".join(f"registry_entries.{k} IS NOT excluded.{k}" for k in COLUMNS[1:]))
            db.execute("DELETE FROM registry_entries WHERE NOT EXISTS(SELECT 1 FROM snapshot s WHERE s.entry_key=registry_entries.entry_key)")
        for name, cols in [("sales", "sales,source_row"), ("contact", "customer,phone,source_row"), ("source_row", "source_row")]:
            db.execute(f"CREATE INDEX IF NOT EXISTS registry_by_{name} ON registry_entries({cols})")
        if db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='registry_links'").fetchone():
            counts["obsolete_links_removed"] = db.execute(
                """DELETE FROM registry_links
                   WHERE (type='sales' AND NOT EXISTS (SELECT 1 FROM registry_entries e WHERE e.sales=source_name))
                      OR (type='investor' AND NOT EXISTS
                          (SELECT 1 FROM registry_entries e WHERE e.customer=source_name AND e.phone=source_phone))"""
            ).rowcount
        if db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='company_record_progress'").fetchone():
            db.execute("""DELETE FROM company_record_progress WHERE kind='registry' AND NOT EXISTS
                          (SELECT 1 FROM registry_entries e WHERE e.entry_key=company_record_progress.record_id)""")
        old_meta = dict(db.execute("SELECT key,value FROM registry_meta"))
        if add or update or remove or old_meta.get("source_name") != source_name or old_meta.get("row_count") != str(counts["accepted_rows"]):
            meta = [("source_name", source_name), ("row_count", str(counts["accepted_rows"])),
                    ("imported_at", datetime.now(timezone.utc).isoformat(timespec="seconds"))]
            db.executemany("INSERT INTO registry_meta VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", meta)
        counts.update(added=add, updated=update, removed=remove)
        db.commit()
    except BaseException:
        db.rollback()
        raise


def import_registry(workbook, database):
    if not workbook.is_file() or workbook.resolve() == database.resolve():
        raise RegistryError("请指定可读取的 XLSX 和单独的 SQLite 文件")
    db = sqlite3.connect(database, timeout=30)
    counts = Counter()
    try:
        db.execute("PRAGMA foreign_keys=ON")
        db.execute("PRAGMA temp_store=MEMORY")
        stage_workbook(db, workbook, counts)
        db.commit()
        sync(db, workbook.name, counts)
    finally:
        db.close()
    return dict(counts)


def main():
    parser = argparse.ArgumentParser(description="导入股民登记总表到本地 SQLite 台账")
    parser.add_argument("workbook", type=Path)
    parser.add_argument("--db", required=True, type=Path)
    args = parser.parse_args()
    try:
        counts = import_registry(args.workbook, args.db)
    except RegistryError as exc:
        sys.exit(str(exc))
    except (OSError, BadZipFile, ET.ParseError, sqlite3.Error, ValueError, KeyError, IndexError) as exc:
        sys.exit(f"导入失败 ({type(exc).__name__})，请检查工作簿及数据库。")
    print(json.dumps(counts, ensure_ascii=False))


if __name__ == "__main__":
    main()
