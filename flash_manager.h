#ifndef FLASH_MANAGER_H
#define FLASH_MANAGER_H

#include <stdint.h>
#include <stdbool.h>

// 定义写Flash的请求结构体
typedef struct {
    uint32_t address;      // 写入的目标Flash地址
    const uint8_t *data;   // 数据源指针
    uint32_t length;       // 数据长度（字节）
    void (*callback)(bool success); // 写入完成后的回调函数（可选）
} FlashWriteRequest_t;

// 初始化Flash管理任务
void Flash_Manager_Init(void);

// 外部任务调用此接口将写请求放入队列
bool Flash_Manager_Write_Async(uint32_t addr, const uint8_t *data, uint32_t len, void (*callback)(bool));

#endif // FLASH_MANAGER_H
