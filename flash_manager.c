#include "flash_manager.h"
#include <string.h>

// 假设我们使用的是 FreeRTOS，这里包含相关的头文件
// #include "FreeRTOS.h"
// #include "queue.h"
// #include "semphr.h"
// #include "task.h"

// 模拟的 RTOS 句柄（实际项目中请替换为真实的 RTOS 句柄）
typedef void* QueueHandle_t;
typedef void* TaskHandle_t;
#define pdTRUE 1
#define pdFALSE 0

static QueueHandle_t xFlashQueue = NULL;
static TaskHandle_t xFlashTaskHandle = NULL;

#define FLASH_QUEUE_LENGTH   10
#define FLASH_TASK_STACK_SZ  512
#define FLASH_TASK_PRIO      2

// 模拟底层 Flash 硬件写入函数（通常由厂商提供，如 HAL_FLASH_Program）
// 使用 __attribute__((section(".data"))) 可以确保该函数在 RAM 中运行，防止 XIP 模式下取指冲突。
// 不同的编译器有不同的修饰符，如 Keil 的 __ramfunc，IAR 的 __ramfunc，GCC 的 section
#if defined(__GNUC__)
__attribute__((section(".data")))
#endif
static bool LowLevel_Flash_Write(uint32_t address, const uint8_t *data, uint32_t length) {
    // 1. 关闭中断，防止在擦写 Flash 时触发中断服务程序（中断向量表通常在 Flash 中）
    // uint32_t primask = __get_PRIMASK();
    // __disable_irq();

    bool success = true;

    // 2. 执行擦除或写入逻辑（此处为示意代码）
    // FLASH_Unlock();
    // if (FLASH_Erase(address) != OK) success = false;
    // if (success && FLASH_Write(address, data, length) != OK) success = false;
    // FLASH_Lock();

    // 3. 恢复中断
    // __set_PRIMASK(primask);

    return success;
}

// Flash 串行写入管理任务
static void Flash_Manager_Task(void *pvParameters) {
    FlashWriteRequest_t request;

    while (1) {
        // 从队列中等待写请求，portMAX_DELAY 表示无限期阻塞直到有数据进来
        // if (xQueueReceive(xFlashQueue, &request, portMAX_DELAY) == pdTRUE) {
        {
            // 模拟从队列获取数据
            bool status = LowLevel_Flash_Write(request.address, request.data, request.length);
            
            // 写入完成，调用回调通知发送者
            if (request.callback != NULL) {
                request.callback(status);
            }
        }
    }
}

void Flash_Manager_Init(void) {
    // 1. 创建队列
    // xFlashQueue = xQueueCreate(FLASH_QUEUE_LENGTH, sizeof(FlashWriteRequest_t));
    
    // 2. 创建单任务用于串行管理 Flash 写入
    // xTaskCreate(Flash_Manager_Task, "FlashTask", FLASH_TASK_STACK_SZ, NULL, FLASH_TASK_PRIO, &xFlashTaskHandle);
}

bool Flash_Manager_Write_Async(uint32_t addr, const uint8_t *data, uint32_t len, void (*callback)(bool)) {
    FlashWriteRequest_t request;
    request.address = addr;
    request.data = data;
    request.length = len;
    request.callback = callback;

    // 非阻塞地将写请求放入队列，如果队列满了就返回 false
    // if (xQueueSend(xFlashQueue, &request, 0) == pdPASS) {
    //     return true;
    // }
    return false;
}
