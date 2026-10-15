import { number, object, text } from "./config.js";

/** Validate stack references and event balance before summarizing an external profile. */
export function parseSpeedscope(value: unknown): unknown {
	const data = object(value, "Speedscope");
	const shared = object(data.shared, "shared");
	if (!Array.isArray(shared.frames) || !shared.frames.length)
		throw Error("Speedscope requires frames");
	const frames = shared.frames.map((raw) => {
		const frame = object(raw, "frame");
		text(frame.name, "frame.name");
		return frame;
	});
	const frameIndex = (id: unknown): number => {
		if (!Number.isInteger(id) || (id as number) < 0 || (id as number) >= frames.length)
			throw Error("Invalid Speedscope frame reference");
		return id as number;
	};
	if (!Array.isArray(data.profiles) || !data.profiles.length)
		throw Error("Speedscope requires profiles");
	return data.profiles.map((raw) => {
		const p = object(raw, "profile");
		text(p.name, "profile.name");
		if (
			!["none", "nanoseconds", "microseconds", "milliseconds", "seconds", "bytes"].includes(
				p.unit as string,
			)
		)
			throw Error("Invalid Speedscope unit");
		const start = number(p.startValue, "startValue");
		const end = number(p.endValue, "endValue", start);
		const totals = new Map<number, number>();
		let records = 0;
		if (p.type === "sampled") {
			if (
				!Array.isArray(p.samples) ||
				!p.samples.length ||
				!Array.isArray(p.weights) ||
				p.samples.length !== p.weights.length
			)
				throw Error("Invalid Speedscope samples/weights");
			for (const [i, stack] of p.samples.entries()) {
				if (!Array.isArray(stack)) throw Error("Invalid sampled stack");
				for (const id of stack) frameIndex(id);
				const weight = number(p.weights[i], "sample weight");
				const leaf = stack.at(-1);
				if (leaf !== undefined) totals.set(leaf, (totals.get(leaf) ?? 0) + weight);
			}
			records = p.samples.length;
		} else if (p.type === "evented") {
			if (!Array.isArray(p.events) || !p.events.length) throw Error("Invalid Speedscope events");
			const stack: number[] = [];
			let previous = start;
			for (const raw of p.events) {
				const event = object(raw, "event");
				const at = number(event.at, "event.at", previous);
				if (at > end) throw Error("Event outside profile interval");
				const id = frameIndex(event.frame);
				const leaf = stack.at(-1);
				if (leaf !== undefined) totals.set(leaf, (totals.get(leaf) ?? 0) + at - previous);
				if (event.type === "O") stack.push(id);
				else if (event.type !== "C" || stack.pop() !== id)
					throw Error("Unbalanced Speedscope events");
				previous = at;
			}
			if (stack.length) throw Error("Unclosed Speedscope frames");
			records = p.events.length;
		} else throw Error("Unsupported Speedscope profile type");
		return {
			name: p.name,
			type: p.type,
			unit: p.unit,
			interval: end - start,
			records,
			hotspots: [...totals]
				.sort((a, b) => b[1] - a[1])
				.slice(0, 20)
				.map(([id, selfWeight]) => ({ frame: frames[id], selfWeight })),
			note: "Self weight in the declared profile unit; not process utilization or a performance pass.",
		};
	});
}
