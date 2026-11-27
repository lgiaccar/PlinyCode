import { useLayoutEffect, useRef, useState } from "react";

/** Follow streaming only while at the bottom; remember each chat's reading position. */
export function useChatScroll(id: string | undefined) {
	const container = useRef<HTMLDivElement>(null);
	const content = useRef<HTMLDivElement>(null);
	const positions = useRef(new Map<string, { top: number; follow: boolean }>());
	const following = useRef(true);
	const [away, setAway] = useState(false);
	function jump() {
		const node = container.current;
		if (!node) return;
		following.current = true;
		node.scrollTop = node.scrollHeight;
		setAway(false);
		if (id) positions.current.set(id, { top: node.scrollTop, follow: true });
	}
	function onScroll() {
		const node = container.current;
		if (!node) return;
		following.current =
			node.scrollHeight - node.scrollTop - node.clientHeight < 48;
		setAway(!following.current);
		if (id)
			positions.current.set(id, {
				top: node.scrollTop,
				follow: following.current,
			});
	}
	useLayoutEffect(() => {
		const node = container.current;
		const body = content.current;
		if (!node || !body || !id) return;
		const saved = positions.current.get(id);
		following.current = saved?.follow ?? true;
		node.scrollTop = following.current ? node.scrollHeight : (saved?.top ?? 0);
		setAway(!following.current);
		const observer = new ResizeObserver(() => {
			if (following.current) node.scrollTop = node.scrollHeight;
		});
		observer.observe(body);
		observer.observe(node);
		return () => {
			observer.disconnect();
		};
	}, [id]);
	return { container, content, onScroll, away, jump };
}
