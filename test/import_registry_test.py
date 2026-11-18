"""Run with python -B test/import_registry_test.py; all fixtures live in a temporary folder."""
from pathlib import Path
from contextlib import closing
import sqlite3
import sys
from tempfile import TemporaryDirectory
import unittest
from xml.etree import ElementTree as ET
from zipfile import ZipFile

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from import_registry import BASE_DATA, HEADERS, NS, REL, SHEET, RegistryError, import_registry


def workbook(path, records, missing_header=False, extra_headers=None):
    book = ET.Element(NS + "workbook")
    ET.SubElement(ET.SubElement(book, NS + "sheets"), NS + "sheet", {"name": SHEET, REL + "id": "rId1"})
    rels = ET.Element("Relationships")
    ET.SubElement(rels, "Relationship", {"Id": "rId1", "Target": "worksheets/sheet1.xml"})
    sheet = ET.Element(NS + "worksheet")
    data = ET.SubElement(sheet, NS + "sheetData")
    headers = {**HEADERS, **(extra_headers or {})}
    titles = list(headers)
    if missing_header:
        titles.remove("销售")
    values = [titles] + [[record.get(headers[title], "") for title in titles] for record in records]
    for index, line in enumerate(values, start=2):
        row = ET.SubElement(data, NS + "row", r=str(index))
        for i, value in enumerate(line):
            cell = ET.SubElement(row, NS + "c", r=f"{chr(65+i)}{index}", t="inlineStr")
            ET.SubElement(ET.SubElement(cell, NS + "is"), NS + "t").text = value
    with ZipFile(path, "w") as z:
        for name, root in [("xl/workbook.xml", book), ("xl/_rels/workbook.xml.rels", rels), ("xl/worksheets/sheet1.xml", sheet)]:
            z.writestr(name, ET.tostring(root, encoding="utf-8"))


class ImportTest(unittest.TestCase):
    def test_atomic_snapshot_and_links(self):
        with TemporaryDirectory() as td:
            dest = Path(td) / "db.sqlite"
            xlsx = Path(td) / "register.xlsx"
            with closing(sqlite3.connect(dest)) as db:
                db.executescript("CREATE TABLE business(id INTEGER); INSERT INTO business VALUES(8);"
                                 "CREATE TABLE registry_links(type,source_name,source_phone,identity_id);"
                                 "INSERT INTO registry_links VALUES('sales','测试甲','',1);"
                                 "INSERT INTO registry_links VALUES('investor','模拟股民','19900000000',2);")
                row = dict(serial="1", customer="模拟股民", phone="19900000000", sales="测试甲", stock_name="示例证券",
                           stock_code="000001", source="自由备注含地址", closed="√", registered_on="2026/5/24")
                other = dict(row, customer="模拟乙", phone="19900000000 / 19900000001", serial="", sales="*标签",
                             closed="", filed="否", registered_on="日期待核")
                odd = dict(other, serial="3", customer="含\n换行", phone="19900000002")
                workbook(xlsx, [row, other, other, odd])
                result = import_registry(xlsx, dest)
                self.assertEqual(result["accepted_rows"], 4)
                self.assertEqual(result["fallback_key_rows"], 2)
                read = lambda: db.execute("SELECT * FROM registry_entries ORDER BY source_row").fetchall()
                raw = read()
                self.assertEqual(raw[0][3:], ("19900000000", "测试甲", "示例证券", "000001", "", "2026-05-24", "", "已结案", "closure", "closed", ""))
                self.assertEqual(raw[1][3:5], ("", "*标签"))
                self.assertEqual(raw[1][-4:], ("未立案", "", "", ""))
                self.assertEqual(raw[3][2:4], ("股民姓名待核对", ""))
                self.assertEqual(len({r[0] for r in raw}), 4)
                self.assertEqual(import_registry(xlsx, dest)["updated"], 0)
                self.assertEqual(read(), raw)
                db.execute("CREATE TABLE company_record_progress(kind,record_id)")
                db.executemany("INSERT INTO company_record_progress VALUES(?,?)",
                               [("registry", raw[0][0]), ("registry", raw[1][0]), ("lead", "synthetic-lead")])
                db.commit()
                workbook(xlsx, [dict(row, phone="19900009999", stage="", closed="否")])
                result = import_registry(xlsx, dest)
                self.assertEqual((result["added"], result["updated"], result["removed"], result["obsolete_links_removed"]), (0, 1, 3, 1))
                self.assertEqual(read()[0][0], raw[0][0])
                self.assertEqual(set(db.execute("SELECT * FROM company_record_progress")),
                                 {("registry", raw[0][0]), ("lead", "synthetic-lead")})
                self.assertEqual(db.execute("SELECT type FROM registry_links").fetchall(), [("sales",)])
                current = read()
                for bad in [False, True]:
                    workbook(xlsx, [], missing_header=bad)
                    with self.assertRaises(RegistryError):
                        import_registry(xlsx, dest)
                    self.assertEqual(current, read())
                    self.assertEqual(db.execute("SELECT * FROM business").fetchall(), [(8,)])

    def test_progress_source_specific_evidence_and_legacy_schema(self):
        extras = {"一审案号": "first_case", "二审案号": "appeal_case", "执行进展": "execution_progress",
                  "结案方式": "closing_method", "赔偿款是否支付给原告": "paid_out", "合同编号": "contract",
                  "合同备注": "irrelevant"}
        cases = [
            ({"progress": "已立案未开庭", "first_case": "(2026)测01民初18号"}, ("first_hearing", "awaiting_hearing")),
            ({"progress": "已立案未开庭", "first_case": "(2026)测01民初18号", "appeal_case": "已登记"}, ("", "")),
            ({"progress": "已立案未开庭", "first_case": "待填"}, ("", "")),
            ({"progress": "二审待开庭", "contract": "DEMO-2026-A"}, ("appeal", "awaiting_hearing")),
            ({"progress": "已调解待支付", "paid_out": "√"}, ("", "")),
            ({"progress": "执行中", "execution_progress": "撤回执行"}, ("", "")),
            ({"progress": "已立案未开庭", "execution_progress": "执行中"}, ("enforcement", "in_progress")),
            ({"progress": "执行中", "closing_method": "债权申报获赔", "closed": "√"}, ("closure", "closed")),
            ({"progress": "案件已发回重审", "irrelevant": "TEST-CONTRACT-789"}, ("appeal", "remanded")),
            ({"progress": "已结案", "closed": "×"}, ("", "")),
            ({"filed": "债权申报", "progress": "重整债权已申报"}, ("", "")),
            ({"progress": "一审已开庭待判决"}, ("first_hearing", "awaiting_judgment")),
            ({"progress": "二审等待判决结果"}, ("appeal", "awaiting_judgment")),
            ({"closing_method": "债权申报获赔"}, ("debt_claim", "compensated")),
            ({"progress": "债权申报待补充材料"}, ("debt_claim", "supplement")),
            ({"filed": "否", "contract": "19900000000"}, ("", "")),
            ({"filed": "是", "progress": "已签约待立案"}, ("", "")),
            ({"filed": "立案退回", "progress": "已立案未开庭", "first_case": "(2026)测01民初18号"}, ("", "")),
        ]
        with TemporaryDirectory() as td:
            dest = Path(td) / "db.sqlite"
            xlsx = Path(td) / "registry.xlsx"
            base = dict(customer="合成股民", stock_name="合成股票", sales="测试员")
            workbook(xlsx, [dict(base, serial=str(i), **values) for i, (values, _) in enumerate(cases, 1)],
                     extra_headers=extras)
            with closing(sqlite3.connect(dest)) as db:
                db.execute("CREATE TABLE registry_entries (entry_key TEXT PRIMARY KEY,source_row INTEGER,"
                           + ",".join(f"{k} TEXT NOT NULL" for k in BASE_DATA) + ")")
                self.assertEqual(import_registry(xlsx, dest)["added"], len(cases))
                actual = db.execute("SELECT progress_stage,progress_node,contract_number FROM registry_entries ORDER BY source_row").fetchall()
                self.assertEqual([r[:2] for r in actual], [wanted for _, wanted in cases])
                self.assertEqual([r[2] for r in actual if r[2]], ["DEMO-2026-A"])
                self.assertEqual(import_registry(xlsx, dest)["updated"], 0)


if __name__ == "__main__":
    unittest.main()
