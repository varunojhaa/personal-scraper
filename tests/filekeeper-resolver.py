"""Execute the exported Python, with HTTP, sleep, and wget mocked offline."""
import io
import json
from pathlib import Path
import shlex
import sys
import tempfile
import unittest
from email.message import Message
from unittest.mock import patch
from urllib.parse import parse_qs


payload = json.load(sys.stdin)
command = shlex.split(payload["command"])
assert command[:4] == ["setsid", "nohup", "bash", "-c"]
script = shlex.split(command[4])
start = script.index("python3")
command = script[start:start + 5]
assert command[:2] == ["python3", "-c"], command[:2]
source = command[2]
compile(source, "generated-filekeeper", "exec")
definitions, marker, _ = source.rpartition("\ntry:\n    raise SystemExit(main())")
assert marker, "Could not find generated resolver entry point"
namespace = {}
with patch.object(sys, "argv", ["-c", *command[3:]]):
    exec(definitions, namespace)

idm = {"__name__": "test_export"}
exec(compile(payload["idm"], "generated-idm", "exec"), idm)

fixture = Path(__file__).with_name("fixtures").joinpath("filekeeper-countdown.html").read_text(encoding="utf-8")
page_url = "https://filekeeper.net/download"
tunnel = "https://cdn.dlproxy.uk/download/example?signature=abc%2Bdef&expires=123"


def parse(page):
    parsed = namespace["PageParser"]()
    parsed.feed(page)
    parsed.close()
    return parsed


class Response(io.BytesIO):
    def __init__(self, url, page):
        super().__init__(page.encode())
        self.url = url
        self.headers = Message()
        self.headers["Content-Type"] = "text/html; charset=utf-8"

    def geturl(self):
        return self.url


class CountdownTests(unittest.TestCase):
    def test_observed_fields_and_wait(self):
        parsed = parse(fixture)
        self.assertEqual(parsed.forms, [])
        self.assertIsNone(namespace["choose_form"](parsed))
        form, button = namespace["countdown_form"](parsed)
        target, data = namespace["form_request"](page_url, form, button)
        self.assertEqual(target, page_url)
        self.assertEqual(form["delay"], 5)
        self.assertEqual(parse_qs(data.decode(), keep_blank_values=True), {
            "op": ["download2"], "id": ["example12345"], "rand": [""],
            "referer": ["https://filekeeper.net/"],
            "method_free": ["Free download"], "down_direct": ["1"],
        })

    def test_values_are_encoded_not_executed(self):
        page = fixture.replace('data-rand=""', 'data-rand="a+b&amp;x=1"').replace(
            'data-method=""', 'data-method="Free &amp; slow"')
        form, button = namespace["countdown_form"](parse(page))
        target, data = namespace["form_request"](page_url, form, button)
        fields = parse_qs(data.decode())
        self.assertEqual(fields["rand"], ["a+b&x=1"])
        self.assertEqual(fields["method_free"], ["Free & slow"])
        self.assertEqual(target, page_url)

    def test_protected_or_incomplete_widgets_are_rejected(self):
        for key in ("password", "captcha"):
            page = fixture.replace(f'data-has-{key}="false"', f'data-has-{key}="true"')
            with self.subTest(key=key), self.assertRaisesRegex(ValueError, "use the browser"):
                namespace["countdown_form"](parse(page))
        for attribute in ('data-code="example12345"', 'data-rand=""',
                          'data-countdown="5"', 'data-has-captcha="false"'):
            with self.subTest(attribute=attribute), self.assertRaises(ValueError):
                namespace["countdown_form"](parse(fixture.replace(attribute, "")))
        with self.assertRaisesRegex(ValueError, "ambiguous"):
            namespace["countdown_form"](parse(fixture + fixture))
        self.assertIsNone(namespace["countdown_form"](parse("<p>Unavailable</p>")))

    def test_delay_defaults_and_limits(self):
        for value, expected in (("0", 5), ("-1", -1), ("12", 12)):
            form, _ = namespace["countdown_form"](parse(
                fixture.replace('data-countdown="5"', f'data-countdown="{value}"')))
            self.assertEqual(form["delay"], expected)
        with patch.object(namespace["time"], "sleep") as sleep:
            with self.assertRaisesRegex(SystemExit, "longer than 10 minutes"):
                namespace["wait_for"](601)
            sleep.assert_not_called()

    def test_destination_restrictions(self):
        form, button = namespace["countdown_form"](parse(fixture))
        for action in ("https://evil.example/download", "http://filekeeper.net/download"):
            with self.subTest(action=action), self.assertRaisesRegex(SystemExit, "cross-origin"):
                namespace["form_request"](page_url, dict(form, action=action), button)
        self.assertFalse(namespace["is_download"]("https://dlproxy.uk.evil.example/download/token"))

    def test_initial_form_countdown_post_and_wget_handoff(self):
        initial = '<form action="/download" method="post"><input name="op" value="download1"><input name="id" value="example12345"><button name="method_free" value="Free download">Free download</button></form>'
        requests = []

        def open_request(request, timeout):
            self.assertEqual(timeout, 60)
            requests.append(request)
            if len(requests) == 1:
                return Response(request.full_url, initial)
            if len(requests) == 2:
                self.assertEqual(request.full_url, page_url)
                return Response(page_url, fixture)
            self.assertEqual(len(requests), 3)
            self.assertEqual(request.full_url, page_url)
            self.assertEqual(request.get_header("Referer"), page_url)
            self.assertEqual(request.get_header("Content-type"), "application/x-www-form-urlencoded")
            self.assertEqual(parse_qs(request.data.decode())["op"], ["download2"])
            raise namespace["DownloadRedirect"](tunnel)

        def wget(args):
            self.assertEqual(args[0], "wget")
            self.assertEqual(args[-2:], ["--", tunnel])
            self.assertIn("--referer=" + page_url, args)
            cookies = next(arg.split("=", 1)[1] for arg in args if arg.startswith("--load-cookies="))
            self.assertTrue(Path(cookies).is_file())
            return 0

        with patch.object(namespace["opener"], "open", side_effect=open_request), \
                patch.object(namespace["time"], "sleep") as sleep, \
                patch.object(namespace["subprocess"], "call", side_effect=wget) as download:
            self.assertEqual(namespace["main"](), 0)
            sleep.assert_called_once_with(6)
            download.assert_called_once()

    def test_repeated_countdown_stops_at_step_limit_with_debug_html(self):
        with tempfile.TemporaryDirectory() as directory, \
                patch.object(namespace["os"], "getcwd", return_value=directory), \
                patch.object(namespace["opener"], "open", side_effect=lambda *a, **kw: Response(page_url, fixture)) as fetch, \
                patch.object(namespace["time"], "sleep"), \
                patch.object(namespace["subprocess"], "call") as download:
            with self.assertRaisesRegex(SystemExit, "Inspect the saved HTML"):
                namespace["main"]()
            self.assertEqual(fetch.call_count, namespace["MAX_STEPS"] + 1)
            download.assert_not_called()
            debug = list(Path(directory).glob("filekeeper-debug-*.html"))
            self.assertEqual(len(debug), 1)
            self.assertEqual(debug[0].read_text(encoding="utf-8"), fixture)

    def test_idm_countdown_resolution_does_not_download(self):
        requests = []

        def open_request(request, timeout):
            requests.append(request)
            if len(requests) == 1:
                return Response(page_url, fixture)
            self.assertEqual(parse_qs(request.data.decode())["op"], ["download2"])
            raise idm["DownloadRedirect"](tunnel)

        idm["url"] = command[3]
        with patch.object(idm["opener"], "open", side_effect=open_request), \
                patch.object(idm["time"], "sleep") as sleep, \
                patch.object(idm["subprocess"], "call") as download:
            self.assertEqual(idm["main"](resolve_only=True), (tunnel, page_url, ""))
            sleep.assert_called_once_with(6)
            download.assert_not_called()
            self.assertEqual(len(requests), 2)


class IdmExportTests(unittest.TestCase):
    def test_only_destination_cookies_are_exported(self):
        jar = idm["jar"]
        jar.clear()
        for domain, cookie_name in (("filekeeper.net", "page_only"), ("cdn.dlproxy.uk", "tunnel_session")):
            jar.set_cookie(idm["http"].cookiejar.Cookie(
                version=0, name=cookie_name, value="private", port=None,
                port_specified=False, domain=domain, domain_specified=True,
                domain_initial_dot=False, path="/", path_specified=True,
                secure=True, expires=None, discard=True, comment=None,
                comment_url=None, rest={}, rfc2109=False,
            ))
        with patch.dict(idm, url=tunnel):
            link, referer, cookie = idm["main"](resolve_only=True)
        self.assertEqual(link, tunnel)
        self.assertEqual(cookie, "tunnel_session=private")
        jar.clear()

    def test_batch_selection_headers_failures_and_no_overwrite(self):
        files = [{"url": f"https://filekeeper.net/code{i}/part{i}.rar", "name": f"part{i}.rar"}
                 for i in range(186)]
        seen = []

        def resolve(resolve_only=False):
            self.assertTrue(resolve_only)
            seen.append(idm["url"])
            if len(seen) == 2:
                raise SystemExit("verification required")
            return tunnel, page_url, "session=abc\r\ninjected: bad"

        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "links.txt"
            args = ["filekeeper-idm.py", "--start", "11", "--count", "3", "--output", str(output)]
            with patch.dict(idm, FILES=files, main=resolve), patch.object(sys, "argv", args):
                self.assertEqual(idm["export_idm"](), 1)
                text = output.read_text(encoding="utf-8")
                self.assertEqual(seen, [item["url"] for item in files[10:13]])
                self.assertEqual(text.strip().splitlines(), [tunnel, tunnel])
                self.assertNotIn("referer:", text)
                self.assertNotIn("User-Agent:", text)
                self.assertNotIn("Cookie:", text)
                self.assertNotIn("\ninjected:", text)
                with self.assertRaises(FileExistsError):
                    idm["export_idm"]()
                self.assertEqual(output.read_text(encoding="utf-8"), text)

    def test_all_186_and_default_batch_size(self):
        files = [{"url": f"https://filekeeper.net/code{i}/part{i}.rar", "name": f"part{i}.rar"}
                 for i in range(186)]
        with tempfile.TemporaryDirectory() as directory:
            for case, (options, expected) in enumerate((([], 100), (["--count", "100"], 100), (["--count", "186"], 186)), 1):
                output = Path(directory) / f"links-{expected}-{case}.txt"
                args = ["filekeeper-idm.py", "--output", str(output), *options]
                with patch.dict(idm, FILES=files), patch.object(sys, "argv", args), \
                        patch.dict(idm, main=lambda resolve_only: (tunnel, page_url, "")):
                    self.assertEqual(idm["export_idm"](), 0)
                self.assertEqual(len(output.read_text(encoding="utf-8").strip().splitlines()), expected)

    def test_invalid_batch_rejected_before_output(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "links.txt"
            for options in (["--start", "0"], ["--count", "0"], ["--count", "187"], ["--start", "999"]):
                with patch.object(sys, "argv", ["filekeeper-idm.py", "--output", str(output), *options]):
                    with self.assertRaises(SystemExit):
                        idm["export_idm"]()
                self.assertFalse(output.exists())


unittest.main(argv=[sys.argv[0]])