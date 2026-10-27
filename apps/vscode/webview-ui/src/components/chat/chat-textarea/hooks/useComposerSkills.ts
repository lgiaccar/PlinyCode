import { EmptyRequest } from "@shared/proto/cline/common"
import type { SkillInfo } from "@shared/proto/cline/file"
import { useCallback, useEffect, useState } from "react"
import { FileServiceClient } from "@/services/grpc-client"

function mergeSkills(globalSkills: SkillInfo[] = [], localSkills: SkillInfo[] = []): SkillInfo[] {
	const byPath = new Map<string, SkillInfo>()
	for (const skill of [...globalSkills, ...localSkills]) {
		byPath.set(skill.path, skill)
	}
	return [...byPath.values()]
}

export function useComposerSkills(): SkillInfo[] {
	const [skills, setSkills] = useState<SkillInfo[]>([])

	const refresh = useCallback(() => {
		FileServiceClient.refreshSkills({} as EmptyRequest)
			.then((response) => setSkills(mergeSkills(response.globalSkills, response.localSkills)))
			.catch(() => setSkills([]))
	}, [])

	useEffect(() => {
		refresh()
		const unsubscribe = FileServiceClient.subscribeToCustomizationChanges({} as EmptyRequest, {
			onResponse: () => refresh(),
			onError: () => {},
			onComplete: () => {},
		})
		return () => unsubscribe()
	}, [refresh])

	return skills
}
