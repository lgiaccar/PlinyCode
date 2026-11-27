import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DraftStore } from "../src/draft-store";
import { DraftBook } from "../src/drafts";
import { webLink } from "../src/links";
import { TaskManager } from "../src/manager";
import { DesktopStore } from "../src/store";

async function folder() {
	const scratch = resolve(import.meta.dir, "../../../ai_output");
	await mkdir(scratch, { recursive: true });
	return mkdtemp(join(scratch, "desktop-interactions-"));
}
async function until(check: () => boolean) {
	const deadline = Date.now() + 30_000;
	while (!check()) {
		if (Date.now() > deadline) throw new Error("Timed out waiting for task");
		await Bun.sleep(10);
	}
}

test("drafts survive reopening and ignore stale writes and stale send clears", async () => {
	const file = join(await folder(), "drafts.json");
	const a = randomUUID(),
		b = randomUUID();
	const store = new DraftStore(file);
	store.save(a, { text: "A\nwith details", revision: 2 });
	store.save(b, { text: "B", revision: 1 });
	store.save(a, { text: "stale", revision: 1 });
	const reopened = new DraftStore(file);
	expect(reopened.drafts[a].text).toBe("A\nwith details");
	const book = new DraftBook();
	book.hydrate(reopened.drafts);
	book.set(a, "newer");
	expect(book.clearIfUnchanged(a, 2)).toBe(false);
	store.save(a, book.get(a));
	expect(new DraftStore(file).drafts[a].text).toBe("newer");
	expect(new DraftStore(file).drafts[b].text).toBe("B");
});

test("web links allow HTTPS/HTTP and reject OS handlers, credentials and controls", () => {
	expect(webLink("https://example.com/a?q=1#details")).toBe(
		"https://example.com/a?q=1#details",
	);
	expect(webLink("http://localhost:1234/test")).toBe(
		"http://localhost:1234/test",
	);
	for (const url of [
		"javascript:alert(1)",
		"file:///C:/test.exe",
		"vscode://file/a",
		"data:text/html,test",
		"https://user:pass@example.com",
		"https://example.com\n",
		"//example.com",
		"C:\\test.exe",
	])
		expect(webLink(url)).toBeUndefined();
});

test("steering reaches a live worker in order, queued follow-ups run after completion", async () => {
	const directory = await folder();
	const worker = join(directory, "worker.js");
	await writeFile(
		worker,
		`
import { createInterface } from 'node:readline';
const send=e=>process.stdout.write(JSON.stringify(e)+'\\n');
createInterface({input:process.stdin}).on('line',line=>{
 const c=JSON.parse(line);
 if(c.type==='run') {
  send({type:'ready'});
  if(c.input.prompt==='follow-up') send({type:'done',status:'completed',text:'follow-up finished'});
 }
 if(c.type==='steer') {
  send({type:'steering',id:c.id,status:'received'});
  send({type:'text',text:c.prompt});
  if(c.prompt==='second correction') send({type:'done',status:'completed',text:'done'});
 }
});setInterval(()=>{},1000);
`,
	);
	const manager = new TaskManager(
		new DesktopStore(join(directory, "state.json")),
		directory,
		process.execPath,
		worker,
		() => {},
		async () => "fixture",
	);
	try {
		const project = await manager.addProject(directory);
		const task = manager.createTask(project.id, false);
		manager.send(task.id, "initial");
		manager.send(task.id, "first correction", false, "steer");
		manager.send(task.id, "follow-up", false, "queue");
		manager.send(task.id, "second correction", false, "steer");
		await until(() => task.status === "completed" && !manager.running.size);
		expect(
			task.messages.filter((m) => m.role === "user").map((m) => m.text),
		).toEqual([
			"initial",
			"first correction",
			"second correction",
			"follow-up",
		]);
		expect(task.messages.at(-1)?.text).toBe("follow-up finished");
		expect(task.pendingMessages).toEqual([]);
	} finally {
		await manager.close();
	}
}, 60_000);

test("worker failure holds queued work instead of starting another turn", async () => {
	const directory = await folder();
	const worker = join(directory, "failure-worker.js");
	await writeFile(
		worker,
		`
import { createInterface } from 'node:readline';
createInterface({input:process.stdin}).once('line', () => {
 process.stdout.write(JSON.stringify({type:'done',status:'failed',error:'fixture failure',text:''})+'\\n');
});setInterval(()=>{},1000);
`,
	);
	const manager = new TaskManager(
		new DesktopStore(join(directory, "state.json")),
		directory,
		process.execPath,
		worker,
		() => {},
		async () => "fixture",
	);
	try {
		const project = await manager.addProject(directory);
		const task = manager.createTask(project.id, false);
		manager.send(task.id, "initial");
		manager.send(task.id, "must wait for review", false, "queue");
		await until(() => task.status === "failed" && !manager.running.size);
		expect(task.pendingMessages?.[0].status).toBe("held");
		expect(task.messages.filter((entry) => entry.role === "user").length).toBe(
			1,
		);
		manager.removePending(task.id, task.pendingMessages![0].id);
		expect(task.pendingMessages).toEqual([]);
	} finally {
		await manager.close();
	}
}, 60_000);

test("cancellation and reopening hold pending messages without replay", async () => {
	const directory = await folder();
	const file = join(directory, "state.json");
	const store = new DesktopStore(file);
	const manager = new TaskManager(
		store,
		directory,
		process.execPath,
		"unused",
		() => {},
		async () => "fixture",
	);
	const project = await manager.addProject(directory);
	const task = manager.createTask(project.id, false);
	manager.running.set(task.id, {
		controller: new AbortController(),
		folder: directory,
		folders: [directory],
	});
	task.status = "running";
	manager.send(task.id, "keep this", false, "queue");
	await manager.cancel(task.id);
	expect(task.pendingMessages?.[0].status).toBe("held");
	const reopened = new DesktopStore(file);
	expect(reopened.state.tasks[0].pendingMessages?.[0].text).toBe("keep this");
	expect(reopened.state.tasks[0].pendingMessages?.[0].status).toBe("held");
	manager.running.clear();
	await manager.close();
});
