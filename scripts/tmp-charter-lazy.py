import io

p = 'electron/main.ts'
s = io.open(p, encoding='utf-8').read()

# 1. 移除顶层实例化（模块加载时 store 尚为 null，导致 main.js 加载崩溃）
bad = ("// 内容规范（2026-09-01 刘总定名）：全局/项目两级表达章程，产出型动作统一注入。\n"
       "const contentCharterService = new ContentCharterService(store.raw);\n"
       "contentCharterService.ensureDefault();\n")
assert bad in s, 'top-level instantiation found'
s = s.replace(bad, '')

# 2. 惰性单例：挂在 store 声明之后
lazy = ("// 内容规范服务（惰性单例）：store 在 app ready 后才可用。\n"
        "let contentCharterService: ContentCharterService | null = null;\n"
        "function ensureContentCharterService(): ContentCharterService {\n"
        "  if (!contentCharterService) contentCharterService = new ContentCharterService(store!.raw);\n"
        "  return contentCharterService;\n"
        "}\n")
anchor = "const gotSingleInstanceLock = app.requestSingleInstanceLock();"
assert anchor in s, 'lock anchor'
s = s.replace(anchor, lazy + "\n" + anchor, 1)

# 3. 全部引用改为惰性获取
s = s.replace("contentCharterService.resolveWritingPrompt(", "ensureContentCharterService().resolveWritingPrompt(")
s = s.replace("contentCharterService.list(", "ensureContentCharterService().list(")
s = s.replace("contentCharterService.get(", "ensureContentCharterService().get(")
s = s.replace("contentCharterService.save(", "ensureContentCharterService().save(")
s = s.replace("contentCharterService.delete(", "ensureContentCharterService().delete(")
s = s.replace("contentCharterService.setActive(", "ensureContentCharterService().setActive(")
s = s.replace("contentCharterService.resolveActive(", "ensureContentCharterService().resolveActive(")
s = s.replace("const charter = contentCharterService.resolveActive(projectId);", "const charter = ensureContentCharterService().resolveActive(projectId);")

io.open(p, 'w', encoding='utf-8', newline='\n').write(s)
print('lazy singleton fixed')
