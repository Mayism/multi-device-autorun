import { z } from 'zod'

export const loginFormSchema = z.object({
  mobile: z.string().regex(/^1\d{10}$/, '请输入 11 位手机号码'),
  password: z.string().regex(/^123456$/, '演示密码为 123456'),
})

export const transferFormSchema = z.object({
  fromAccountId: z.string().min(1, '请选择付款账户'),
  beneficiaryId: z.string().min(1, '请选择收款人'),
  amountMinor: z.number().int().positive('转账金额必须大于 0'),
  remark: z.string().max(20, '附言最多 20 个字符').optional(),
})
